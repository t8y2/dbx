import { describe, expect, it } from "vitest";
import { currentStatementFrameRangeTo } from "@/lib/sql/currentStatementFrame";
import type { SqlTextRange } from "@/lib/sql/sqlStatementRanges";

function frameDocument(sql: string) {
  return {
    length: sql.length,
    sliceString: (from: number, to: number) => sql.slice(from, to),
  };
}

describe("currentStatementFrameRangeTo", () => {
  it("includes a directly adjacent trailing semicolon in frame width calculations", () => {
    const sql = "SELECT 1;";
    const range: SqlTextRange = { from: 0, to: "SELECT 1".length, sql: "SELECT 1" };
    expect(currentStatementFrameRangeTo(frameDocument(sql), range)).toBe(sql.length);
  });

  it("includes a trailing semicolon on its own line", () => {
    const sql = "SELECT 1\n;\n\nSELECT 2;";
    const range: SqlTextRange = { from: 0, to: "SELECT 1".length, sql: "SELECT 1" };
    expect(currentStatementFrameRangeTo(frameDocument(sql), range)).toBe(sql.indexOf(";") + 1);
  });

  it("does not extend the frame across a comment before a later semicolon", () => {
    const sql = "SELECT 1\n-- comment\n;";
    const range: SqlTextRange = { from: 0, to: "SELECT 1".length, sql: "SELECT 1" };
    expect(currentStatementFrameRangeTo(frameDocument(sql), range)).toBe(range.to);
  });

  it("does not extend the frame across a blank line before a later semicolon", () => {
    const sql = "SELECT 1\n\n;";
    const range: SqlTextRange = { from: 0, to: "SELECT 1".length, sql: "SELECT 1" };
    expect(currentStatementFrameRangeTo(frameDocument(sql), range)).toBe(range.to);
  });

  it("does not extend the frame when the next non-whitespace character is not a semicolon", () => {
    const sql = "SELECT 1\n\nSELECT 2";
    const range: SqlTextRange = { from: 0, to: "SELECT 1".length, sql: "SELECT 1" };
    expect(currentStatementFrameRangeTo(frameDocument(sql), range)).toBe(range.to);
  });
});
