import { describe, expect, it } from "vitest";
import { matchesResultClientFilter, type ResultClientFilter } from "@/lib/dataGrid/gridClientFilter";
import type { CellValue } from "@/lib/dataGrid/cellValue";

const row: CellValue[] = ["orders-001", 42, null, "Pending", 3.5];

describe("matchesResultClientFilter (#13237)", () => {
  function f(mode: ResultClientFilter["mode"], value: CellValue = "", colIndex = 0): ResultClientFilter {
    return { colIndex, mode, value };
  }

  it("equals matches text exactly and numbers only against numbers", () => {
    expect(matchesResultClientFilter(row, f("equals", "orders-001"))).toBe(true);
    expect(matchesResultClientFilter(row, f("equals", 42, 1))).toBe(true);
    // Typed comparison: a number cell is not the text "42" and vice versa.
    expect(matchesResultClientFilter([42], f("equals", "42"))).toBe(false);
    expect(matchesResultClientFilter(["42"], f("equals", 42))).toBe(false);
    expect(matchesResultClientFilter(row, f("equals", "orders-002"))).toBe(false);
  });

  it("not-equals inverts equals for non-null rows and excludes NULL", () => {
    expect(matchesResultClientFilter(row, f("not-equals", "orders-001"))).toBe(false);
    expect(matchesResultClientFilter(row, f("not-equals", "other"))).toBe(true);
    // `col <> value` is unknown for NULL in SQL, so NULL rows stay out.
    expect(matchesResultClientFilter([null], f("not-equals", "other"))).toBe(false);
    expect(matchesResultClientFilter([""], f("not-equals", ""))).toBe(false);
    expect(matchesResultClientFilter(["x"], f("not-equals", ""))).toBe(true);
  });

  it("like / not-like are case-insensitive substrings and skip NULL", () => {
    expect(matchesResultClientFilter(row, f("like", "PENDING", 3))).toBe(true);
    expect(matchesResultClientFilter(row, f("not-like", "pending", 3))).toBe(false);
    expect(matchesResultClientFilter([null], f("like", ""))).toBe(false);
    expect(matchesResultClientFilter([null], f("not-like", "pending"))).toBe(false);
  });

  it("less-than / greater-than compare numbers numerically and text by collation", () => {
    expect(matchesResultClientFilter(row, f("less-than", 100, 1))).toBe(true);
    expect(matchesResultClientFilter(row, f("greater-than", 100, 1))).toBe(false);
    expect(matchesResultClientFilter(row, f("less-than", "1", 0))).toBe(false);
    expect(matchesResultClientFilter(row, f("greater-than", 3, 4))).toBe(true);
    // Text is never parsed as a number: "9" < "10" numerically, but not as text.
    expect(matchesResultClientFilter(["9"], f("less-than", "10"))).toBe(false);
    expect(matchesResultClientFilter(["9"], f("less-than", "10"), "varchar")).toBe(false);
    // A numeric column type opts into numeric ordering for string-encoded cells.
    expect(matchesResultClientFilter(["9"], f("less-than", "10"), "int")).toBe(true);
    expect(matchesResultClientFilter([null], f("less-than", 10))).toBe(false);
  });

  it("is-null / is-not-null are strictly null and undefined", () => {
    expect(matchesResultClientFilter(row, f("is-null", null, 2))).toBe(true);
    expect(matchesResultClientFilter(row, f("is-not-null", null, 2))).toBe(false);
    expect(matchesResultClientFilter([undefined as unknown as CellValue], f("is-null", null))).toBe(true);
    expect(matchesResultClientFilter(row, f("is-not-null", null, 3))).toBe(true);
    // Empty text is a value, not NULL.
    expect(matchesResultClientFilter([""], f("is-null", null))).toBe(false);
    expect(matchesResultClientFilter([""], f("is-not-null", null))).toBe(true);
  });

  it("equals / not-equals on a NULL value behave like is-null / is-not-null", () => {
    expect(matchesResultClientFilter([null], f("equals", null))).toBe(true);
    expect(matchesResultClientFilter([null], f("equals", ""))).toBe(false);
    expect(matchesResultClientFilter([""], f("equals", null))).toBe(false);
    expect(matchesResultClientFilter([""], f("equals", ""))).toBe(true);
    expect(matchesResultClientFilter(["x"], f("not-equals", null))).toBe(true);
    expect(matchesResultClientFilter(["x"], f("not-equals", ""))).toBe(true);
    expect(matchesResultClientFilter([null], f("not-equals", null))).toBe(false);
  });

  it("does not coerce numeric-looking text on a text column (#13419)", () => {
    expect(matchesResultClientFilter(["007"], f("equals", "007"))).toBe(true);
    expect(matchesResultClientFilter(["007"], f("equals", "7"))).toBe(false);
    expect(matchesResultClientFilter(["7"], f("equals", "007"))).toBe(false);
    expect(matchesResultClientFilter(["1.0"], f("equals", "1"))).toBe(false);
    expect(matchesResultClientFilter(["1e3"], f("equals", "1000"))).toBe(false);
    // The row that `col = '007'` keeps must survive "not equals 7".
    expect(matchesResultClientFilter(["007"], f("not-equals", "7"))).toBe(true);
    // Numeric column types keep numeric semantics.
    expect(matchesResultClientFilter(["007"], f("equals", "7"), "int")).toBe(true);
    expect(matchesResultClientFilter(["1.0"], f("equals", "1"), "numeric(10,2)")).toBe(true);
    expect(matchesResultClientFilter(["1e3"], f("equals", "1000"), "float8")).toBe(true);
  });
});
