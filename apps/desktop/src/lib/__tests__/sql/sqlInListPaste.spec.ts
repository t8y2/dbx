import { describe, expect, it } from "vitest";
import { buildSqlInConditionFromPasteSource, insertTextForSqlInCondition, SQL_IN_LIST_PASTE_MAX_SOURCE_LENGTH, SQL_IN_LIST_PASTE_MAX_VALUES } from "@/lib/sql/sqlInListPaste";

describe("sqlInListPaste", () => {
  it("builds an IN condition from newline values", () => {
    expect(buildSqlInConditionFromPasteSource("A\nB\nC")).toEqual({
      ok: true,
      sql: "IN ('A', 'B', 'C')",
      valueCount: 3,
    });
  });

  it("splits comma, tab, and newline separated clipboard content", () => {
    expect(buildSqlInConditionFromPasteSource("A\tB\nC,D")).toEqual({
      ok: true,
      sql: "IN ('A', 'B', 'C', 'D')",
      valueCount: 4,
    });
  });

  it("splits simple slash-separated value lists", () => {
    expect(buildSqlInConditionFromPasteSource("1/2/3")).toEqual({
      ok: true,
      sql: "IN (1, 2, 3)",
      valueCount: 3,
    });
    expect(buildSqlInConditionFromPasteSource("A/B/C")).toEqual({
      ok: true,
      sql: "IN ('A', 'B', 'C')",
      valueCount: 3,
    });
  });

  it("does not treat common dates, URLs, or absolute paths as value lists", () => {
    expect(buildSqlInConditionFromPasteSource("2026/07/07")).toEqual({ ok: false, reason: "not-list" });
    expect(buildSqlInConditionFromPasteSource("http://example.com/a/b")).toEqual({ ok: false, reason: "not-list" });
    expect(buildSqlInConditionFromPasteSource("/Users/staff/dbx")).toEqual({ ok: false, reason: "not-list" });
  });

  it("preserves numeric and NULL literals while quoting strings", () => {
    expect(buildSqlInConditionFromPasteSource("1\n-2.5\n001\nnull\nA1")).toEqual({
      ok: true,
      sql: "IN (1, -2.5, '001', NULL, 'A1')",
      valueCount: 5,
    });
  });

  it("strips existing SQL list wrappers and escapes single quotes once", () => {
    expect(buildSqlInConditionFromPasteSource("('O''Reilly', \"Bob\")")).toEqual({
      ok: true,
      sql: "IN ('O''Reilly', 'Bob')",
      valueCount: 2,
    });
    expect(buildSqlInConditionFromPasteSource("IN ('A', 'B')")).toEqual({
      ok: true,
      sql: "IN ('A', 'B')",
      valueCount: 2,
    });
    expect(buildSqlInConditionFromPasteSource("('A')")).toEqual({
      ok: true,
      sql: "IN ('A')",
      valueCount: 1,
    });
  });

  it("does not split delimiters inside quoted values", () => {
    expect(buildSqlInConditionFromPasteSource("'A,B'\n'C\tD'")).toEqual({
      ok: true,
      sql: "IN ('A,B', 'C\tD')",
      valueCount: 2,
    });
  });

  it("treats apostrophes inside unquoted values as text", () => {
    expect(buildSqlInConditionFromPasteSource("O'Reilly\nBob")).toEqual({
      ok: true,
      sql: "IN ('O''Reilly', 'Bob')",
      valueCount: 2,
    });
  });

  it("returns empty for blank or delimiter-only content", () => {
    expect(buildSqlInConditionFromPasteSource(" \n,\t ")).toEqual({ ok: false, reason: "empty" });
  });

  it("does not process unrelated single text values", () => {
    expect(buildSqlInConditionFromPasteSource("paste some random text here")).toEqual({ ok: false, reason: "not-list" });
    expect(buildSqlInConditionFromPasteSource("O'Reilly")).toEqual({ ok: false, reason: "not-list" });
  });

  it("guards very large paste input and value count", () => {
    expect(buildSqlInConditionFromPasteSource("x".repeat(SQL_IN_LIST_PASTE_MAX_SOURCE_LENGTH + 1))).toEqual({
      ok: false,
      reason: "too-large",
      limit: SQL_IN_LIST_PASTE_MAX_SOURCE_LENGTH,
    });
    expect(buildSqlInConditionFromPasteSource(Array.from({ length: SQL_IN_LIST_PASTE_MAX_VALUES + 1 }, (_, index) => String(index)).join("\n"))).toEqual({
      ok: false,
      reason: "too-many-values",
      limit: SQL_IN_LIST_PASTE_MAX_VALUES,
    });
  });

  it("avoids duplicating IN when the cursor is already after IN or NOT IN", () => {
    expect(insertTextForSqlInCondition("IN ('A')", "where id in ")).toBe("('A')");
    expect(insertTextForSqlInCondition("IN ('A')", "where id not in")).toBe("('A')");
    expect(insertTextForSqlInCondition("IN ('A')", "where id")).toBe(" IN ('A')");
    expect(insertTextForSqlInCondition("IN ('A')", "where id = ")).toBe("IN ('A')");
  });
});
