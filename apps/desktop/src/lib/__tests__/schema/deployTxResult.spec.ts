import { describe, expect, it } from "vitest";
import type { BackendError } from "@/lib/backend/errorUtils";
import { buildContinueOnErrorDeployLog, buildDeployTxResult } from "@/lib/schema/deployTxResult";
import type { QueryResult } from "@/types/database";

function statementResult(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    columns: [],
    rows: [],
    affected_rows: 0,
    execution_time_ms: 1,
    ...overrides,
  };
}

function backendError(detail: string): BackendError {
  return {
    version: 1,
    code: "DBX-SQL-0001",
    messageKey: "errors.sqlExecution",
    messageParams: {},
    source: "test",
    operationOutcome: "not_started",
    detail,
  };
}

const t = (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key);

describe("buildContinueOnErrorDeployLog", () => {
  it("reports a clean commit when every statement succeeded", () => {
    const log = buildContinueOnErrorDeployLog([statementResult({ statement_index: 0 }), statementResult({ statement_index: 1, execution_time_ms: 2 })]);

    expect(log.status).toBe("committed");
    expect(log.executed_count).toBe(2);
    expect(log.statement_count).toBe(2);
    expect(log.metadata.failures).toEqual([]);
    expect(log.error).toBeNull();
  });

  it("keeps going past a failure and records the failed statement index and error", () => {
    const log = buildContinueOnErrorDeployLog([statementResult({ statement_index: 0 }), statementResult({ statement_index: 1, execution_error: true, error: backendError("Duplicate column name 'nickname'") }), statementResult({ statement_index: 2 })]);

    expect(log.status).toBe("completed_with_errors");
    expect(log.executed_count).toBe(3);
    expect(log.statement_count).toBe(3);
    expect(log.metadata.failures).toEqual([{ index: 1, error: "Duplicate column name 'nickname'" }]);
    expect(log.error).toContain("#2: Duplicate column name 'nickname'");
  });

  it("falls back to the result position when the backend did not tag the statement index", () => {
    const log = buildContinueOnErrorDeployLog([statementResult(), statementResult({ execution_error: true, error: backendError("syntax error") })]);

    expect(log.metadata.failures).toEqual([{ index: 1, error: "syntax error" }]);
  });
});

describe("buildDeployTxResult continue-on-error", () => {
  it("surfaces the executed/failed counts and every failed statement", () => {
    const log = buildContinueOnErrorDeployLog([statementResult({ statement_index: 0 }), statementResult({ statement_index: 1, execution_error: true, error: backendError("boom") }), statementResult({ statement_index: 2, execution_error: true, error: backendError("bang") })]);

    const result = buildDeployTxResult(log, t);

    expect(result.success).toBe(false);
    expect(result.status).toBe("completed_with_errors");
    expect(result.message).toContain("diff.deployCompletedWithErrors");
    expect(result.message).toContain('"executedCount":3');
    expect(result.message).toContain('"failedCount":2');
    expect(result.failedCount).toBe(2);
    expect(result.failures).toEqual([
      { index: 1, error: "boom" },
      { index: 2, error: "bang" },
    ]);
  });

  it("treats an all-success continue-on-error run as a normal commit", () => {
    const result = buildDeployTxResult(buildContinueOnErrorDeployLog([statementResult({ statement_index: 0 })]), t);

    expect(result.success).toBe(true);
    expect(result.status).toBe("committed");
    expect(result.failedCount).toBeUndefined();
  });
});
