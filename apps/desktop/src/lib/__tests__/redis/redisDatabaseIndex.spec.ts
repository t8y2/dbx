import { describe, expect, it } from "vitest";
import { effectiveRedisDatabaseIndex, normalizeRedisDatabaseValue } from "@/lib/redis/redisDatabaseIndex";

describe("effectiveRedisDatabaseIndex", () => {
  it("keeps numeric indexes as-is", () => {
    expect(effectiveRedisDatabaseIndex("0")).toBe("0");
    expect(effectiveRedisDatabaseIndex("3")).toBe("3");
    expect(effectiveRedisDatabaseIndex(" 15 ")).toBe("15");
  });

  it("falls back to db 0 for dirty values, mirroring dbx-core redis_database_index()", () => {
    expect(effectiveRedisDatabaseIndex("0 --tls --insecure")).toBe("0");
    expect(effectiveRedisDatabaseIndex("3 --foo")).toBe("0");
    expect(effectiveRedisDatabaseIndex("mydb")).toBe("0");
    expect(effectiveRedisDatabaseIndex("")).toBe("0");
    expect(effectiveRedisDatabaseIndex(undefined)).toBe("0");
    expect(effectiveRedisDatabaseIndex(null)).toBe("0");
  });
});

describe("normalizeRedisDatabaseValue", () => {
  it("passes numeric indexes through trimmed", () => {
    expect(normalizeRedisDatabaseValue("3")).toBe("3");
    expect(normalizeRedisDatabaseValue(" 3 ")).toBe("3");
  });

  it("collapses dirty values to the index the backend actually uses", () => {
    expect(normalizeRedisDatabaseValue("0 --tls --insecure")).toBe("0");
    expect(normalizeRedisDatabaseValue("cache")).toBe("0");
  });

  it("keeps empty values unset", () => {
    expect(normalizeRedisDatabaseValue("")).toBeUndefined();
    expect(normalizeRedisDatabaseValue("   ")).toBeUndefined();
    expect(normalizeRedisDatabaseValue(undefined)).toBeUndefined();
  });
});
