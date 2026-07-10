import { Text } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { executableStatementRangeAtCursor, executableStatementRangeCacheForDoc, executableStatementRangeStartingAt, type ExecutableStatementRangeParser } from "@/lib/sql/executableStatementRangeCache";

describe("executableStatementRangeCacheForDoc", () => {
  it("reuses parsed executable statement ranges for the same document and database type", () => {
    const doc = Text.of(["SELECT 1;", "SELECT 2;"]);
    const parse = vi.fn<ExecutableStatementRangeParser>(() => [
      { from: 0, to: 8, sql: "SELECT 1" },
      { from: 10, to: 18, sql: "SELECT 2" },
    ]);

    const first = executableStatementRangeCacheForDoc(null, doc, "mysql", parse);
    const second = executableStatementRangeCacheForDoc(first, doc, "mysql", parse);

    expect(second).toBe(first);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(executableStatementRangeStartingAt(second, 10)?.sql).toBe("SELECT 2");
  });

  it("resolves the exact multi-line statement for a gutter run button", () => {
    const doc = Text.of(["SELECT *", "FROM apis AS ap", "LIMIT 100;", "", "SELECT *", "FROM menus AS mn", "LIMIT 100;"]);

    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");
    const secondStatementLine = doc.line(5);

    expect(executableStatementRangeStartingAt(cache, secondStatementLine.from)?.sql).toBe("SELECT *\nFROM menus AS mn\nLIMIT 100");
  });

  it("resolves statements with leading whitespace for gutter run buttons", () => {
    const doc = Text.of([" SELECT 1;", "  SELECT 2;", "\t SELECT 3;", "", "    "]);
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");

    expect(executableStatementRangeStartingAt(cache, doc.line(1).from)?.sql).toBe("SELECT 1");
    expect(executableStatementRangeStartingAt(cache, doc.line(2).from)?.sql).toBe("SELECT 2");
    expect(executableStatementRangeStartingAt(cache, doc.line(3).from)?.sql).toBe("SELECT 3");
    expect(executableStatementRangeStartingAt(cache, doc.line(4).from)).toBeNull();
    expect(executableStatementRangeStartingAt(cache, doc.line(5).from)).toBeNull();
  });

  it("does not resolve gutter run buttons when non-whitespace precedes the statement on the same line", () => {
    const doc = Text.of(["/* comment */ SELECT 1;"]);
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");

    expect(executableStatementRangeStartingAt(cache, doc.line(1).from)).toBeNull();
    expect(executableStatementRangeStartingAt(cache, doc.toString().indexOf("SELECT"))?.sql).toBe("SELECT 1");
  });

  it("resolves the current statement from a cursor inside a continuation line", () => {
    const doc = Text.of(["SELECT *", "FROM apis AS ap", "LIMIT 100;", "", "SELECT *", "FROM menus AS mn", "LIMIT 100;"]);
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");
    const cursor = doc.toString().indexOf("menus");

    expect(executableStatementRangeAtCursor(cache, cursor)?.sql).toBe("SELECT *\nFROM menus AS mn\nLIMIT 100");
  });

  it("keeps indentation and same-line semicolon gaps attached to the current statement", () => {
    const doc = Text.of(["SELECT 1;", "    SELECT 2;"]);
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");
    const indentationCursor = doc.line(2).from + 2;
    const semicolonGapCursor = doc.toString().indexOf(";") + 1;

    expect(executableStatementRangeAtCursor(cache, indentationCursor)?.sql).toBe("SELECT 2");
    expect(executableStatementRangeAtCursor(cache, semicolonGapCursor)?.sql).toBe("SELECT 1");
  });

  it("returns null for blank and pure comment cursor lines", () => {
    const doc = Text.of(["SELECT 1;", "-- comment", "/* block comment */", "", "SELECT 2;"]);
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");

    expect(executableStatementRangeAtCursor(cache, doc.line(2).from + 3)).toBeNull();
    expect(executableStatementRangeAtCursor(cache, doc.line(3).from + 3)).toBeNull();
    expect(executableStatementRangeAtCursor(cache, doc.line(4).from)).toBeNull();
  });

  it("resolves SQL after a leading block comment on the same line", () => {
    const doc = Text.of(["/* comment */ SELECT 1;"]);
    const cache = executableStatementRangeCacheForDoc(null, doc, "mysql");

    expect(executableStatementRangeAtCursor(cache, doc.toString().indexOf("SELECT"))?.sql).toBe("SELECT 1");
    expect(executableStatementRangeAtCursor(cache, doc.toString().indexOf("comment"))).toBeNull();
  });

  it("rebuilds the cache when the document instance changes", () => {
    const firstDoc = Text.of(["SELECT 1;"]);
    const secondDoc = Text.of(["SELECT 1;"]);
    const parse = vi.fn<ExecutableStatementRangeParser>(() => [{ from: 0, to: 8, sql: "SELECT 1" }]);

    const first = executableStatementRangeCacheForDoc(null, firstDoc, "mysql", parse);
    const second = executableStatementRangeCacheForDoc(first, secondDoc, "mysql", parse);

    expect(second).not.toBe(first);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("rebuilds the cache when the database type changes", () => {
    const doc = Text.of(["SELECT 1;"]);
    const parse = vi.fn<ExecutableStatementRangeParser>(() => [{ from: 0, to: 8, sql: "SELECT 1" }]);

    const mysql = executableStatementRangeCacheForDoc(null, doc, "mysql", parse);
    const postgres = executableStatementRangeCacheForDoc(mysql, doc, "postgres", parse);

    expect(postgres).not.toBe(mysql);
    expect(parse).toHaveBeenCalledTimes(2);
  });
});
