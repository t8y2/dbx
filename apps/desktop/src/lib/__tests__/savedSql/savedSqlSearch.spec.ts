import { describe, expect, it } from "vitest";
import { findSavedSqlSearchMatches, formatMatchTooltip, formatSnippetLine, splitSearchMatchSegments } from "@/lib/savedSql/savedSqlSearch";

describe("splitSearchMatchSegments", () => {
  it("returns empty or untouched segments when input or query is empty", () => {
    expect(splitSearchMatchSegments("", "select")).toEqual([]);
    expect(splitSearchMatchSegments("SELECT 1", "")).toEqual([{ text: "SELECT 1", matched: false }]);
  });

  it("handles text without matches", () => {
    expect(splitSearchMatchSegments("SELECT 1", "from")).toEqual([{ text: "SELECT 1", matched: false }]);
  });

  it("matches case-insensitively and preserves text casing", () => {
    const segments = splitSearchMatchSegments("Select user_id, userName From Users", "user");
    expect(segments).toEqual([
      { text: "Select ", matched: false },
      { text: "user", matched: true },
      { text: "_id, ", matched: false },
      { text: "user", matched: true },
      { text: "Name From ", matched: false },
      { text: "User", matched: true },
      { text: "s", matched: false },
    ]);
  });
});

describe("formatSnippetLine", () => {
  it("keeps short line as trimmed", () => {
    expect(formatSnippetLine("   SELECT * FROM users;  ", "users", 50)).toBe("SELECT * FROM users;");
  });

  it("truncates long lines and centers context when match is deep", () => {
    const longLine = "SELECT a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r, s, t, u, v, w, x, y, z, orders.id FROM very_long_table_name";
    const snippet = formatSnippetLine(longLine, "orders", 30);
    expect(snippet).toContain("orders");
    expect(snippet.startsWith("...")).toBe(true);
  });
});

describe("findSavedSqlSearchMatches", () => {
  it("returns empty result on empty sql or query", () => {
    expect(findSavedSqlSearchMatches("", "select")).toEqual({ matches: [], totalMatches: 0 });
    expect(findSavedSqlSearchMatches("SELECT 1", "")).toEqual({ matches: [], totalMatches: 0 });
  });

  it("finds matching lines with 1-based line numbers and columns", () => {
    const sql = ["-- comments", "SELECT id, name", "  FROM customers", " WHERE status = 'active';"].join("\n");

    const result = findSavedSqlSearchMatches(sql, "from");
    expect(result.totalMatches).toBe(1);
    expect(result.matches).toHaveLength(1);

    const match = result.matches[0];
    expect(match.lineNumber).toBe(3);
    // original line has 2 spaces before FROM, so column is 3
    expect(match.column).toBe(3);
    expect(match.lineText).toBe("FROM customers");
    expect(match.contextBefore).toEqual({ lineNumber: 2, text: "SELECT id, name" });
    expect(match.contextAfter).toEqual({ lineNumber: 4, text: "WHERE status = 'active';" });
    expect(match.segments).toEqual([
      { text: "FROM", matched: true },
      { text: " customers", matched: false },
    ]);
  });

  it("respects maxMatches while maintaining totalMatches", () => {
    const sql = ["SELECT 1;", "SELECT 2;", "SELECT 3;", "SELECT 4;", "SELECT 5;"].join("\n");

    const result = findSavedSqlSearchMatches(sql, "select", { maxMatches: 2 });
    expect(result.totalMatches).toBe(5);
    expect(result.matches).toHaveLength(2);
    expect(result.matches.map((m) => m.lineNumber)).toEqual([1, 2]);
  });
});

describe("formatMatchTooltip", () => {
  it("formats context before, match line, and context after with line numbers", () => {
    const tooltip = formatMatchTooltip({
      lineNumber: 10,
      column: 1,
      lineText: "SELECT * FROM orders",
      segments: [],
      contextBefore: { lineNumber: 9, text: "-- Fetch active orders" },
      contextAfter: { lineNumber: 11, text: "WHERE status = 'active'" },
    });

    expect(tooltip).toBe("9 | -- Fetch active orders\n10 | SELECT * FROM orders\n11 | WHERE status = 'active'");
  });

  it("handles missing context lines gracefully", () => {
    const tooltip = formatMatchTooltip({
      lineNumber: 1,
      column: 1,
      lineText: "SELECT 1;",
      segments: [],
    });

    expect(tooltip).toBe("1 | SELECT 1;");
  });
});
