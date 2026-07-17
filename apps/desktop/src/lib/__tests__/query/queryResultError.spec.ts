import { describe, expect, it } from "vitest";

import type { QueryResult } from "@/types/database";

import { isMysqlExecutionErrorResult, isNoSnapshotErrorResult } from "@/lib/query/queryResultError";

function errorResult(message: string): QueryResult {
  return { columns: ["Error"], rows: [[message]], affected_rows: 0, execution_time_ms: 0 };
}

function dataResult(columns: string[]): QueryResult {
  return { columns, rows: [], affected_rows: 0, execution_time_ms: 0 };
}

describe("isNoSnapshotErrorResult", () => {
  it("matches the StarRocks Paimon no-snapshot error surfaced via executeTabSql", () => {
    const result = errorResult("Server error: `ERROR HY000 (1064): There is currently no snapshot.`");
    expect(isNoSnapshotErrorResult(result)).toBe(true);
  });

  it("matches case-insensitively", () => {
    const result = errorResult("there IS currently NO snapshot");
    expect(isNoSnapshotErrorResult(result)).toBe(true);
  });

  it("does not match unrelated query errors", () => {
    expect(isNoSnapshotErrorResult(errorResult("Unknown table 'tag_test.record_tag_t'"))).toBe(false);
    expect(isNoSnapshotErrorResult(errorResult("ERROR 1142: SELECT command denied"))).toBe(false);
  });

  it("does not match successful data results", () => {
    expect(isNoSnapshotErrorResult(dataResult(["id", "name"]))).toBe(false);
    expect(isNoSnapshotErrorResult(dataResult(["Error"]))).toBe(false); // data column literally named Error, no rows
  });

  it("returns false for missing or empty results", () => {
    expect(isNoSnapshotErrorResult(undefined)).toBe(false);
    expect(isNoSnapshotErrorResult(null)).toBe(false);
    expect(isNoSnapshotErrorResult({ ...errorResult("There is currently no snapshot."), rows: [] })).toBe(false);
  });
});

describe("isMysqlExecutionErrorResult", () => {
  it("recognizes an explicitly marked MySQL batch execution error", () => {
    expect(isMysqlExecutionErrorResult({ ...errorResult("Duplicate entry '1'"), execution_error: true }, "mysql")).toBe(true);
  });

  it("does not mistake an unmarked Error alias without type metadata for an execution error", () => {
    const result: QueryResult = {
      columns: ["Error"],
      rows: [["2"]],
      affected_rows: 0,
      execution_time_ms: 1,
    };
    expect(isMysqlExecutionErrorResult(result, "mysql")).toBe(false);
  });

  it("does not apply the native MySQL heuristic to JDBC connections", () => {
    expect(isMysqlExecutionErrorResult({ ...errorResult("Duplicate entry '1'"), execution_error: true }, "jdbc")).toBe(false);
  });
});
