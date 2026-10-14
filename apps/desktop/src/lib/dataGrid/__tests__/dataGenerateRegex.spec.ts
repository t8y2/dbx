import { describe, expect, it } from "vitest";
import { generateValue } from "@/lib/dataGrid/dataGenerate";
import { generateRegexValue } from "@/lib/dataGrid/regexGenerate";

describe("regex data generation (#12077)", () => {
  it("generates values matching the configured pattern instead of value_N fallback", () => {
    const values = Array.from({ length: 50 }, (_, row) => generateValue("username", "character varying(50)", "regex", row, { pattern: "user_[1-9]{5}" }));
    for (const value of values) expect(value).toMatch(/^user_[1-9]{5}$/);
    expect(new Set(values).size).toBeGreaterThan(1);
  });

  it("supports alternation, classes and quantifiers", () => {
    const cases: Array<[string, RegExp]> = [
      ["(foo|bar)_\\d{2,4}", /^(foo|bar)_\d{2,4}$/],
      ["[A-Z]{3}-[a-z]{2}", /^[A-Z]{3}-[a-z]{2}$/],
      ["v\\d+\\.\\d+", /^v\d+\.\d+$/],
      ["order-[0-9a-f]{8}", /^order-[0-9a-f]{8}$/],
      ["\\w+@example\\.com", /^\w+@example\.com$/],
    ];
    for (const [pattern, re] of cases) {
      for (let row = 0; row < 10; row += 1) {
        const value = generateValue("col", "character varying(64)", "regex", row, { pattern });
        expect(value).toMatch(re);
      }
    }
  });

  it("keeps unbounded quantifiers bounded", () => {
    for (let row = 0; row < 10; row += 1) {
      const value = generateValue("col", "character varying(255)", "regex", row, { pattern: "a+b*" }) as string;
      expect(value).toMatch(/^a+b*$/);
      expect(value.length).toBeLessThanOrEqual(16);
    }
  });

  it("generates values for named and back-referencing groups", () => {
    const result = generateRegexValue("(?<year>\\d{4})-(?<month>\\d{2})");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value).toMatch(/^\d{4}-\d{2}$/);
    const backref = generateRegexValue("(abc)\\1");
    expect(backref.status).toBe("ok");
    if (backref.status !== "ok") return;
    expect(backref.value).toBe("abcabc");
  });

  it("falls back to type defaults for empty or invalid patterns without throwing", () => {
    const empty = generateValue("col", "character varying(20)", "regex", 0, { pattern: "" });
    expect(empty).toBe("value_1");
    const invalid = generateValue("col", "character varying(20)", "regex", 1, { pattern: "(" });
    expect(invalid).toBe("value_2");
  });

  it("reports status instead of throwing for unmatchable patterns", () => {
    expect(generateRegexValue(undefined)).toEqual({ status: "empty" });
    expect(generateRegexValue("   ")).toEqual({ status: "empty" });
    expect(generateRegexValue("(")).toEqual({ status: "invalid" });
    expect(generateRegexValue("(?=a)b")).toEqual({ status: "nomatch" });
  });

  it("raw pattern mode accepts patterns verbatim without auto-anchoring", () => {
    for (let row = 0; row < 10; row += 1) {
      const value = generateValue("col", "character varying(64)", "regex", row, { pattern: "user_\\d+", rawPattern: true }) as string;
      expect(value).toMatch(/user_\d+/);
    }
  });

  it("degrades to fallback instead of throwing for huge counted repeats", () => {
    expect(generateRegexValue("a{2000000000}")).toEqual({ status: "nomatch" });
    const value = generateValue("col", "character varying(20)", "regex", 0, { pattern: "a{2000000000}" });
    expect(value).toBe("value_1");
  });

  it("treats [\\b] in a class as backspace instead of invalid", () => {
    const result = generateRegexValue("[\\b]");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value).toBe("\b");
  });
});
