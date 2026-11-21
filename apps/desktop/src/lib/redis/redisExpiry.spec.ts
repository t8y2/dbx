import { CalendarDateTime, resetLocalTimeZone, setLocalTimeZone } from "@internationalized/date";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calendarDateTimeToUnixSeconds, formatLocalDateTime, parseLocalDateTime, unixSecondsToCalendarDateTime } from "@/components/ui/date-time-picker/dateTimePicker";
import { applyRedisBatchExpiryPolicy, applyRedisExpiryPolicy, parseRedisTtl, redisExpiryModeForTtl, validateRedisExpiry } from "./redisExpiry";

afterEach(() => {
  resetLocalTimeZone();
});

describe("Redis expiry helpers", () => {
  it("only accepts safe positive whole-second TTLs", () => {
    expect(parseRedisTtl("")).toBeNull();
    expect(parseRedisTtl("0")).toBeNull();
    expect(parseRedisTtl("-1")).toBeNull();
    expect(parseRedisTtl("1.5")).toBeNull();
    expect(parseRedisTtl("1seconds")).toBeNull();
    expect(parseRedisTtl(String(Number.MAX_SAFE_INTEGER + 1))).toBeNull();
    expect(parseRedisTtl(" 60 ")).toBe(60);
  });

  it("maps Redis TTL metadata to the expected initial mode", () => {
    expect(redisExpiryModeForTtl(-2)).toBe("none");
    expect(redisExpiryModeForTtl(-1)).toBe("none");
    expect(redisExpiryModeForTtl(1)).toBe("ttl");
  });

  it("validates empty, invalid, past, and future absolute expiry times", () => {
    const now = new Date(2024, 1, 29, 12, 0, 0).getTime();
    const future = new CalendarDateTime(2024, 2, 29, 12, 0, 1);
    const past = new CalendarDateTime(2024, 2, 29, 11, 59, 59);

    expect(validateRedisExpiry("none", "", null, now)).toEqual({ valid: true, policy: { mode: "none" } });
    expect(validateRedisExpiry("ttl", "0", null, now)).toEqual({ valid: false, reason: "ttl" });
    expect(validateRedisExpiry("at", "", null, now)).toEqual({ valid: false, reason: "date" });
    expect(validateRedisExpiry("at", "", past, now)).toEqual({ valid: false, reason: "past" });
    expect(validateRedisExpiry("at", "", future, now)).toEqual({
      valid: true,
      policy: { mode: "at", expireAt: calendarDateTimeToUnixSeconds(future) },
    });
  });

  it("treats DST gaps and overlaps as invalid absolute expiry times", () => {
    setLocalTimeZone("America/Los_Angeles");
    const now = new Date("2024-01-01T00:00:00Z").getTime();

    expect(validateRedisExpiry("at", "", new CalendarDateTime(2024, 3, 10, 2, 30, 0), now)).toEqual({ valid: false, reason: "date" });
    expect(validateRedisExpiry("at", "", new CalendarDateTime(2024, 11, 3, 1, 30, 0), now)).toEqual({ valid: false, reason: "date" });
  });

  it("keeps local calendar fields when parsing, formatting, and converting", () => {
    const leap = parseLocalDateTime("2024-02-29 23:45:06");
    expect(leap).not.toBeNull();
    expect(formatLocalDateTime(leap!)).toBe("2024-02-29 23:45:06");
    expect(parseLocalDateTime("2024-02-30 23:45:06")).toBeNull();
    expect(parseLocalDateTime("2024-02-29T23:45:06")?.toString()).toBe("2024-02-29T23:45:06");

    const roundTrip = unixSecondsToCalendarDateTime(calendarDateTimeToUnixSeconds(leap!));
    expect(formatLocalDateTime(roundTrip)).toBe("2024-02-29 23:45:06");
  });

  it("uses PERSIST, EXPIRE, or EXPIREAT once according to the selected policy", async () => {
    const transport = { setTtl: vi.fn().mockResolvedValue(undefined), setExpireAt: vi.fn().mockResolvedValue(undefined) };

    await applyRedisExpiryPolicy(transport, "connection", 3, "key", { mode: "none" });
    await applyRedisExpiryPolicy(transport, "connection", 3, "key", { mode: "ttl", ttl: 45 });
    await applyRedisExpiryPolicy(transport, "connection", 3, "key", { mode: "at", expireAt: 1_735_689_600 });

    expect(transport.setTtl).toHaveBeenNthCalledWith(1, "connection", 3, "key", -1);
    expect(transport.setTtl).toHaveBeenNthCalledWith(2, "connection", 3, "key", 45);
    expect(transport.setExpireAt).toHaveBeenCalledOnce();
    expect(transport.setExpireAt).toHaveBeenCalledWith("connection", 3, "key", 1_735_689_600);
  });
});

function batchTransport(results: { applied: number; missing_key_raws: string[] }[] = []) {
  const queue = [...results];
  const next = () => Promise.resolve(queue.shift() ?? { applied: 0, missing_key_raws: [] });
  return {
    setKeysTtl: vi.fn().mockImplementation(next),
    setKeysExpireAt: vi.fn().mockImplementation(next),
  };
}

describe("Redis batch expiry helpers", () => {
  it("applies one PERSIST for an empty policy, a TTL for a relative policy, and one EXPIREAT for an absolute policy", async () => {
    const none = batchTransport([{ applied: 1, missing_key_raws: [] }]);
    await applyRedisBatchExpiryPolicy(none, "connection", 3, ["key:a"], { mode: "none" });
    expect(none.setKeysTtl).toHaveBeenCalledWith("connection", 3, ["key:a"], -1);
    expect(none.setKeysExpireAt).not.toHaveBeenCalled();

    const ttl = batchTransport([{ applied: 2, missing_key_raws: [] }]);
    await applyRedisBatchExpiryPolicy(ttl, "connection", 3, ["key:a", "key:b"], { mode: "ttl", ttl: 3_600 });
    expect(ttl.setKeysTtl).toHaveBeenCalledWith("connection", 3, ["key:a", "key:b"], 3_600);
    expect(ttl.setKeysExpireAt).not.toHaveBeenCalled();

    const at = batchTransport([{ applied: 2, missing_key_raws: [] }]);
    await applyRedisBatchExpiryPolicy(at, "connection", 3, ["key:a", "key:b"], { mode: "at", expireAt: 1_735_689_600 });
    expect(at.setKeysExpireAt).toHaveBeenCalledWith("connection", 3, ["key:a", "key:b"], 1_735_689_600);
    expect(at.setKeysTtl).not.toHaveBeenCalled();
  });

  it("sums per-key results and reports the keys the server did not update", async () => {
    const transport = batchTransport([
      { applied: 1, missing_key_raws: ["key:b"] },
      { applied: 1, missing_key_raws: [] },
    ]);

    const summary = await applyRedisBatchExpiryPolicy(transport, "connection", 3, ["key:a", "key:b", "key:c"], { mode: "ttl", ttl: 60 }, 2);

    expect(transport.setKeysTtl).toHaveBeenCalledTimes(2);
    expect(transport.setKeysTtl).toHaveBeenNthCalledWith(1, "connection", 3, ["key:a", "key:b"], 60);
    expect(transport.setKeysTtl).toHaveBeenNthCalledWith(2, "connection", 3, ["key:c"], 60);
    expect(summary).toEqual({ applied: 2, failedKeyRaws: ["key:b"], errors: [] });
  });

  it("sends a large selection as bounded chunks instead of one request per key", async () => {
    const keyRaws = Array.from({ length: 2_501 }, (_, index) => `key:${index}`);
    const transport = batchTransport();

    const summary = await applyRedisBatchExpiryPolicy(transport, "connection", 3, keyRaws, { mode: "none" });

    expect(transport.setKeysTtl.mock.calls.map((call) => call[2].length)).toEqual([1_000, 1_000, 501]);
    expect(summary.failedKeyRaws).toEqual([]);
  });

  it("keeps the keys an earlier chunk already updated when a later chunk fails", async () => {
    const transport = batchTransport([{ applied: 2, missing_key_raws: [] }]);
    transport.setKeysTtl.mockImplementationOnce(() => Promise.resolve({ applied: 2, missing_key_raws: [] }));
    transport.setKeysTtl.mockImplementationOnce(() => Promise.reject(new Error("connection lost")));

    const summary = await applyRedisBatchExpiryPolicy(transport, "connection", 3, ["key:a", "key:b", "key:c"], { mode: "ttl", ttl: 60 }, 2);

    expect(summary.applied).toBe(2);
    expect(summary.failedKeyRaws).toEqual(["key:c"]);
    expect(summary.errors).toEqual(["connection lost"]);
  });

  it("deduplicates the selection and sends nothing for an empty one", async () => {
    const transport = batchTransport([{ applied: 1, missing_key_raws: [] }]);

    const empty = await applyRedisBatchExpiryPolicy(transport, "connection", 3, [], { mode: "none" });
    expect(empty).toEqual({ applied: 0, failedKeyRaws: [], errors: [] });
    expect(transport.setKeysTtl).not.toHaveBeenCalled();

    const summary = await applyRedisBatchExpiryPolicy(transport, "connection", 3, ["key:a", "key:a"], { mode: "none" });
    expect(transport.setKeysTtl).toHaveBeenCalledWith("connection", 3, ["key:a"], -1);
    expect(summary.applied).toBe(1);
  });
});
