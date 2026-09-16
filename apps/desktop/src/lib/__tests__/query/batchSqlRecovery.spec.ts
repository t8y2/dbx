import { describe, expect, it } from "vitest";
import { batchSqlRecoverySql, batchSqlRecoveryState, mergeBatchQueryResults, prepareBatchSqlRecovery } from "@/lib/query/batchSqlRecovery";
import type { BatchSqlExecution, QueryResult } from "@/types/database";

function batch(): BatchSqlExecution {
  return {
    executionId: "first",
    submittedSql: "SELECT 1;\nSELECT bad;\nSELECT 3",
    editorFingerprint: "editor",
    sourceOffset: 10,
    completed: 2,
    total: 3,
    startedAt: 1,
    finishedAt: 2,
    items: [
      { statementIndex: 0, sql: "SELECT 1", from: 10, to: 18, status: "success" },
      {
        statementIndex: 1,
        sql: "SELECT bad",
        from: 20,
        to: 30,
        status: "error",
        error: "bad SQL",
        errorDetails: {
          version: 1,
          code: "DBX-JDBC-4001",
          messageKey: "backendErrors.jdbc.sqlFailed",
          messageParams: { stage: "execute" },
          source: "jdbcAgent",
          operationOutcome: "unknown",
          diagnostics: { category: "sql" },
        },
      },
      { statementIndex: 2, sql: "SELECT 3", from: 32, to: 40, status: "skipped" },
    ],
  };
}

describe("batchSqlRecovery", () => {
  it("offers recovery only for a stopped auto-commit batch with a safe SQL error", () => {
    expect(batchSqlRecoveryState({ autoCommit: true, isExecuting: false, batchSqlExecution: batch() })).toEqual({ failedStatementIndex: 1, remainingStatementCount: 1 });
    expect(batchSqlRecoveryState({ autoCommit: false, isExecuting: false, batchSqlExecution: batch() })).toBeUndefined();
    expect(batchSqlRecoveryState({ autoCommit: true, isExecuting: true, batchSqlExecution: batch() })).toBeUndefined();

    const unsafe = batch();
    unsafe.items[1]!.errorDetails = { ...unsafe.items[1]!.errorDetails!, code: "DBX-JDBC-2002", diagnostics: { category: "timeout" } };
    expect(batchSqlRecoveryState({ autoCommit: true, isExecuting: false, batchSqlExecution: unsafe })).toBeUndefined();

    const legacy = batch();
    legacy.items[1]!.errorDetails = {
      ...legacy.items[1]!.errorDetails!,
      code: "DBX-LEGACY-0001",
      messageKey: "backendErrors.legacy",
      source: "legacyBackend",
      diagnostics: undefined,
    };
    expect(batchSqlRecoveryState({ autoCommit: true, isExecuting: false, batchSqlExecution: legacy })).toBeUndefined();

    legacy.items[2]!.status = "pending";
    expect(batchSqlRecoveryState({ autoCommit: true, isExecuting: false, batchSqlExecution: legacy })).toBeUndefined();

    legacy.items[1]!.errorDetails = undefined;
    legacy.items[1]!.executionTimeMs = 0;
    expect(batchSqlRecoveryState({ autoCommit: true, isExecuting: false, batchSqlExecution: legacy })).toBeUndefined();

    const dismissed = batch();
    dismissed.recoveryDismissed = true;
    expect(batchSqlRecoveryState({ autoCommit: true, isExecuting: false, batchSqlExecution: dismissed })).toBeUndefined();
  });

  it("uses the latest failed statement when a resumed batch stops again", () => {
    const value = batch();
    value.items.push({ statementIndex: 3, sql: "SELECT bad2", from: 42, to: 53, status: "error", errorDetails: value.items[1]!.errorDetails }, { statementIndex: 4, sql: "SELECT 5", from: 55, to: 63, status: "skipped" });
    value.total = 5;
    expect(batchSqlRecoveryState({ autoCommit: true, isExecuting: false, batchSqlExecution: value })).toEqual({ failedStatementIndex: 3, remainingStatementCount: 1 });
  });

  it("restarts from the original submitted SQL and resets only the resumed tail", () => {
    expect(batchSqlRecoverySql(batch(), 1)).toEqual({ sql: "SELECT bad;\nSELECT 3", sourceOffset: 20 });
    expect(prepareBatchSqlRecovery(batch(), "second", 2)).toMatchObject({
      executionId: "second",
      completed: 2,
      finishedAt: undefined,
      items: [{ status: "success" }, { status: "error" }, { status: "running", error: undefined }],
    });
  });

  it("replaces results by global statement index while retaining earlier results", () => {
    const previous = [
      { columns: [], rows: [], affected_rows: 1, execution_time_ms: 1, statement_index: 0 },
      { columns: ["message"], rows: [["second result set"]], affected_rows: 0, execution_time_ms: 1, statement_index: 0 },
      { columns: ["Error"], rows: [["bad"]], affected_rows: 0, execution_time_ms: 1, statement_index: 1, execution_error: true },
    ] as QueryResult[];
    const resumed = [
      { columns: [], rows: [], affected_rows: 1, execution_time_ms: 1, statement_index: 1 },
      { columns: ["message"], rows: [["retried result set"]], affected_rows: 0, execution_time_ms: 1, statement_index: 1 },
      { columns: [], rows: [], affected_rows: 1, execution_time_ms: 1, statement_index: 2 },
    ] as QueryResult[];

    expect(mergeBatchQueryResults(previous, resumed)).toEqual([previous[0], previous[1], resumed[0], resumed[1], resumed[2]]);
  });
});
