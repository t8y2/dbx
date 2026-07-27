import { describe, expect, it } from "vitest";
import { parseOptionalTtl } from "@/lib/kv/kvTtl";

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
