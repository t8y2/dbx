import { CalendarDateTime, resetLocalTimeZone, setLocalTimeZone } from "@internationalized/date";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calendarDateTimeToUnixSeconds, formatLocalDateTime, parseLocalDateTime, unixSecondsToCalendarDateTime } from "@/components/ui/date-time-picker/dateTimePicker";
import { applyRedisExpiryPolicy, parseRedisTtl, redisExpiryModeForTtl, validateRedisExpiry } from "./redisExpiry";

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
