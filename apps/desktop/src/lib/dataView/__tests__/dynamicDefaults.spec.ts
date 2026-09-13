import { describe, expect, it } from "vitest";
import { resolveDynamicDefault } from "@/lib/dataView/dynamicDefaults";

const now = new Date(2026, 7, 29, 14, 5, 9); // 2026-08-29 14:05:09 (local)

describe("resolveDynamicDefault", () => {
  it("resolves {{today}} to a YYYY-MM-DD date", () => {
    expect(resolveDynamicDefault("{{today}}", now)).toBe("2026-08-29");
  });

  it("resolves {{yesterday}} and {{tomorrow}}", () => {
    expect(resolveDynamicDefault("{{yesterday}}", now)).toBe("2026-08-28");
    expect(resolveDynamicDefault("{{tomorrow}}", now)).toBe("2026-08-30");
  });

  it("resolves {{now}} to a timestamp", () => {
    expect(resolveDynamicDefault("{{now}}", now)).toBe("2026-08-29 14:05:09");
  });

  it("passes through literal values and blanks", () => {
    expect(resolveDynamicDefault("hello", now)).toBe("hello");
    expect(resolveDynamicDefault("", now)).toBe("");
    expect(resolveDynamicDefault(null, now)).toBe("");
    expect(resolveDynamicDefault(undefined, now)).toBe("");
  });
});
