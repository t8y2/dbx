import { Text } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { executableStatementRangeCacheForDoc, executableStatementRangeStartingAt, type ExecutableStatementRangeParser } from "@/lib/executableStatementRangeCache";

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
