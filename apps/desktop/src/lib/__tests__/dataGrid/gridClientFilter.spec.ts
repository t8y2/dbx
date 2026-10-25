import { describe, expect, it } from "vitest";
import { matchesResultClientFilter, type ResultClientFilter } from "@/lib/dataGrid/gridClientFilter";

const row = ["orders-001", 42, null, "Pending", 3.5];

describe("matchesResultClientFilter (#13237)", () => {
  function f(mode: ResultClientFilter["mode"], value = "", colIndex = 0): ResultClientFilter {
    return { colIndex, mode, value };
  }

  it("equals matches text exactly and numbers across types", () => {
    expect(matchesResultClientFilter(row, f("equals", "orders-001"))).toBe(true);
    expect(matchesResultClientFilter(row, f("equals", "42", 1))).toBe(true);
    // "42" text cell equals the 42 number cell and vice versa.
    expect(matchesResultClientFilter(["42"], f("equals", 42 as unknown as string))).toBe(true);
    expect(matchesResultClientFilter(row, f("equals", "orders-002"))).toBe(false);
  });

  it("not-equals inverts equals", () => {
    expect(matchesResultClientFilter(row, f("not-equals", "orders-001"))).toBe(false);
    expect(matchesResultClientFilter(row, f("not-equals", "other"))).toBe(true);
  });

  it("like / not-like are case-insensitive substrings", () => {
    expect(matchesResultClientFilter(row, f("like", "PENDING", 3))).toBe(true);
    expect(matchesResultClientFilter(row, f("not-like", "pending", 3))).toBe(false);
  });

  it("less-than / greater-than compare numerically and reject non-numeric cells", () => {
    expect(matchesResultClientFilter(row, f("less-than", "100", 1))).toBe(true);
    expect(matchesResultClientFilter(row, f("greater-than", "100", 1))).toBe(false);
    expect(matchesResultClientFilter(row, f("less-than", "1", 0))).toBe(false);
    expect(matchesResultClientFilter(row, f("greater-than", "3", 4))).toBe(true);
  });

  it("is-null / is-not-null treat null, undefined and empty text as null", () => {
    expect(matchesResultClientFilter(row, f("is-null", "", 2))).toBe(true);
    expect(matchesResultClientFilter(row, f("is-not-null", "", 2))).toBe(false);
    expect(matchesResultClientFilter(row, f("is-not-null", "", 3))).toBe(true);
  });
});
