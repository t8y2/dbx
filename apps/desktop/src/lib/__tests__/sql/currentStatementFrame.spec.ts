import { describe, expect, it } from "vitest";
import { currentStatementFrameRangeTo, estimateInlineHintVisualColumns, isWideSqlChar, visualSqlColumns, visualSqlColumnsWithInlineHints } from "@/lib/sql/currentStatementFrame";
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

describe("visualSqlColumnsWithInlineHints", () => {
  it("adds estimated columns for insert-value hints on the line", () => {
    const text = "VALUES (12, 'a')";
    const lineFrom = 0;
    const lineTo = text.length;
    const withoutHints = visualSqlColumns(text);
    const withHints = visualSqlColumnsWithInlineHints(text, lineFrom, lineTo, [
      { from: 8, column: "id" },
      { from: 12, column: "name" },
    ]);
    expect(withHints).toBe(withoutHints + estimateInlineHintVisualColumns("id") + estimateInlineHintVisualColumns("name"));
  });

  it("ignores hints that belong to other lines", () => {
    const text = "VALUES (1)";
    expect(visualSqlColumnsWithInlineHints(text, 0, text.length, [{ from: 100, column: "id" }])).toBe(visualSqlColumns(text));
  });

  it("dedupes hints that share the same document offset", () => {
    const text = "VALUES (1)";
    const once = visualSqlColumnsWithInlineHints(text, 0, text.length, [{ from: 8, column: "id" }]);
    const twice = visualSqlColumnsWithInlineHints(text, 0, text.length, [
      { from: 8, column: "id" },
      { from: 8, column: "id" },
    ]);
    expect(twice).toBe(once);
  });
});
