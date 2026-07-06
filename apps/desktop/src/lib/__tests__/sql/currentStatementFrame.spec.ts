import { describe, expect, it } from "vitest";
import { currentStatementFrameRangeTo, isWideSqlChar, visualSqlColumns } from "@/lib/sql/currentStatementFrame";
import type { SqlTextRange } from "@/lib/sql/sqlStatementRanges";

describe("currentStatementFrameRangeTo", () => {
  it("includes a directly adjacent trailing semicolon in frame width calculations", () => {
    const range: SqlTextRange = { from: 0, to: "SELECT 1".length, sql: "SELECT 1" };
    expect(currentStatementFrameRangeTo(";", range)).toBe(range.to + 1);
  });

  it("does not extend the frame when the next character is not a semicolon", () => {
    const range: SqlTextRange = { from: 0, to: "SELECT 1".length, sql: "SELECT 1" };
    expect(currentStatementFrameRangeTo("\n", range)).toBe(range.to);
  });
});

describe("visualSqlColumns", () => {
  it("counts ASCII as one column, tabs as four, and CJK/fullwidth characters as two", () => {
    expect(visualSqlColumns("A\t中Ｂ")).toBe(1 + 4 + 2 + 2);
  });

  it("recognizes common wide SQL text characters", () => {
    expect(isWideSqlChar("中")).toBe(true);
    expect(isWideSqlChar("Ａ")).toBe(true);
    expect(isWideSqlChar("A")).toBe(false);
  });
});
