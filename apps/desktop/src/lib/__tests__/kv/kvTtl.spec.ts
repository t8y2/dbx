import { describe, expect, it } from "vitest";
import { parseKvLeaseId, parseOptionalTtl } from "@/lib/kv/kvTtl";

describe("parseOptionalTtl", () => {
  it("treats an empty TTL as a permanent key", () => {
    expect(parseOptionalTtl("")).toEqual({ ok: true, ttl: null });
    expect(parseOptionalTtl("  ")).toEqual({ ok: true, ttl: null });
    expect(parseOptionalTtl(undefined)).toEqual({ ok: true, ttl: null });
    expect(parseOptionalTtl(null)).toEqual({ ok: true, ttl: null });
  });

  it("accepts positive integer seconds from text and number inputs", () => {
    expect(parseOptionalTtl("1")).toEqual({ ok: true, ttl: 1 });
    expect(parseOptionalTtl(" 3600 ")).toEqual({ ok: true, ttl: 3600 });
    expect(parseOptionalTtl(10)).toEqual({ ok: true, ttl: 10 });
  });

  it("rejects zero, negative, decimal, and unsafe TTL values", () => {
    expect(parseOptionalTtl("0")).toEqual({ ok: false });
    expect(parseOptionalTtl("-1")).toEqual({ ok: false });
    expect(parseOptionalTtl("1.5")).toEqual({ ok: false });
    expect(parseOptionalTtl(1.5)).toEqual({ ok: false });
    expect(parseOptionalTtl("9007199254740992")).toEqual({ ok: false });
  });
});

describe("parseKvLeaseId", () => {
  it("preserves lease IDs above JavaScript's safe integer limit", () => {
    expect(parseKvLeaseId("9007199254740993")).toBe("9007199254740993");
    expect(parseKvLeaseId("9223372036854775807")).toBe("9223372036854775807");
  });

  it("rejects empty, non-positive, decimal, and overflowing lease IDs", () => {
    expect(parseKvLeaseId("")).toBeNull();
    expect(parseKvLeaseId("0")).toBeNull();
    expect(parseKvLeaseId("-1")).toBeNull();
    expect(parseKvLeaseId("1.5")).toBeNull();
    expect(parseKvLeaseId("9223372036854775808")).toBeNull();
  });
});
