import { describe, expect, it, vi } from "vitest";
import { runBatchTableDrop } from "@/lib/table/batchTableDrop";
import type { QueryResult } from "@/types/database";

function queryResult(overrides: Partial<QueryResult> = {}): QueryResult {
  return { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1, ...overrides };
}

const plan = [
  { target: "orders", sql: "DROP TABLE orders" },
  { target: "customers", sql: "DROP TABLE customers" },
  { target: "events", sql: "DROP TABLE events" },
];

describe("batch table drop", () => {
  it("keeps SQL Server sequential so progress and partial failure stay attributable", async () => {
    const executeStatement = vi.fn(async (sql: string) => {
      if (sql.includes("customers")) throw new Error("permission denied");
    });
    const executeBatch = vi.fn();
    const onProgress = vi.fn();

    const result = await runBatchTableDrop({ databaseType: "sqlserver", plan, executeStatement, executeBatch, onProgress });

    expect(executeStatement.mock.calls.map(([sql]) => sql)).toEqual(["DROP TABLE orders", "DROP TABLE customers"]);
    expect(executeBatch).not.toHaveBeenCalled();
    expect(result.succeeded).toEqual(["orders"]);
    expect(result.failed?.message).toBe("permission denied");
    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { completed: 1, total: 3, success: true },
      { completed: 2, total: 3, success: false },
    ]);
  });

  it("maps indexed batch results back to their exact targets", async () => {
    const result = await runBatchTableDrop({
      databaseType: "mysql",
      plan,
      executeStatement: vi.fn(),
      executeBatch: async () => [queryResult({ statement_index: 0 }), queryResult({ statement_index: 1, execution_error: true, columns: ["Error"], rows: [["locked"]] })],
      onProgress: vi.fn(),
    });

    expect(result.succeeded).toEqual(["orders"]);
    expect(result.failed?.message).toBe("locked");
  });

  it("treats a successful atomic HTTP SQLite batch as all-or-nothing", async () => {
    const onProgress = vi.fn();
    const result = await runBatchTableDrop({
      databaseType: "turso",
      plan,
      executeStatement: vi.fn(),
      executeBatch: async () => [queryResult()],
      onProgress,
    });

    expect(result.succeeded).toEqual(["orders", "customers", "events"]);
    expect(result.failed).toBeUndefined();
    expect(onProgress).toHaveBeenLastCalledWith({ completed: 3, total: 3, success: true });
  });

  it("fails closed when a non-atomic batch omits statement indexes", async () => {
    const result = await runBatchTableDrop({
      databaseType: "postgres",
      plan,
      executeStatement: vi.fn(),
      executeBatch: async () => [queryResult()],
      onProgress: vi.fn(),
    });

    expect(result.succeeded).toEqual([]);
    expect(result.failed?.message).toBe("Batch drop did not report a result for every statement");
  });

  it("succeeds for single table drop when backend returns an indexless result", async () => {
    const singlePlan = [{ target: "platforms", sql: "DROP TABLE `platforms`" }];
    const onProgress = vi.fn();
    const result = await runBatchTableDrop({
      databaseType: "mysql",
      plan: singlePlan,
      executeStatement: vi.fn(),
      executeBatch: async () => [queryResult()],
      onProgress,
    });

    expect(result.succeeded).toEqual(["platforms"]);
    expect(result.failed).toBeUndefined();
    expect(onProgress).toHaveBeenCalledWith({ completed: 1, total: 1, success: true });
  });

  it("reports failure for single table drop when execution error occurs", async () => {
    const singlePlan = [{ target: "platforms", sql: "DROP TABLE `platforms`" }];
    const onProgress = vi.fn();
    const result = await runBatchTableDrop({
      databaseType: "oceanbase-oracle",
      plan: singlePlan,
      executeStatement: vi.fn(),
      executeBatch: async () => [
        queryResult({
          execution_error: true,
          error: {
            version: 1,
            code: "OBE-00942",
            messageKey: "error.database",
            messageParams: {},
            source: "agent",
            operationOutcome: "unknown",
            detail: "table or view does not exist",
          },
        }),
      ],
      onProgress,
    });

    expect(result.succeeded).toEqual([]);
    expect(result.failed?.message).toBe("table or view does not exist");
  });

  it("maps 1-to-1 sequential indexless batch results when lengths match", async () => {
    const twoPlan = [
      { target: "orders", sql: "DROP TABLE orders" },
      { target: "customers", sql: "DROP TABLE customers" },
    ];
    const onProgress = vi.fn();
    const result = await runBatchTableDrop({
      databaseType: "mysql",
      plan: twoPlan,
      executeStatement: vi.fn(),
      executeBatch: async () => [queryResult(), queryResult({ execution_error: true, rows: [["foreign key constraint fails"]] })],
      onProgress,
    });

    expect(result.succeeded).toEqual(["orders"]);
    expect(result.failed?.message).toBe("foreign key constraint fails");
  });

  it("handles empty drop plan immediately without executing queries", async () => {
    const executeStatement = vi.fn();
    const executeBatch = vi.fn();
    const onProgress = vi.fn();
    const result = await runBatchTableDrop({
      databaseType: "mysql",
      plan: [],
      executeStatement,
      executeBatch,
      onProgress,
    });

    expect(result.succeeded).toEqual([]);
    expect(result.failed).toBeUndefined();
    expect(executeStatement).not.toHaveBeenCalled();
    expect(executeBatch).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });
});
