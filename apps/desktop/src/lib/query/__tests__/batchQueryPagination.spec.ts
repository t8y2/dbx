import { describe, expect, it, vi } from "vitest";
import { prepareBatchQueryPagination } from "@/lib/query/batchQueryPagination";
import type { QueryPaginationExecutionPlan, QueryPaginationExecutionPlanOptions } from "@/lib/backend/tauri";

function plan(overrides: Partial<QueryPaginationExecutionPlan> = {}): QueryPaginationExecutionPlan {
  return {
    pageSql: "SELECT id FROM t LIMIT 20 OFFSET 0",
    sqlToExecute: "SELECT id FROM t LIMIT 20 OFFSET 0",
    pageProbeSql: "SELECT id FROM t LIMIT 21 OFFSET 0",
    pageLimit: 20,
    pageOffset: 0,
    useAgentResultSession: false,
    ...overrides,
  } as QueryPaginationExecutionPlan;
}

function options(overrides: Partial<QueryPaginationExecutionPlanOptions> = {}): QueryPaginationExecutionPlanOptions {
  return {
    sql: "SELECT a FROM t1; SELECT b FROM t2",
    queryBaseSql: "SELECT a FROM t1; SELECT b FROM t2",
    databaseType: "postgres",
    pagination: { limit: 20, offset: 0 },
    useAgentCursor: false,
    ...overrides,
  } as QueryPaginationExecutionPlanOptions;
}

describe("prepareBatchQueryPagination", () => {
  it("keeps comments and preamble text between statements when rebuilding the batch", async () => {
    const sql = "-- leading comment\nSELECT a FROM t1;\n/* between */ SELECT b FROM t2;\n-- trailing";
    const prepare = vi.fn().mockResolvedValue(plan());
    const result = await prepareBatchQueryPagination(options({ sql, queryBaseSql: sql }), prepare);
    expect(result).toBeTruthy();
    expect(prepare).toHaveBeenCalledTimes(2);
    // Inter-statement text is preserved verbatim; only the SELECT bodies are replaced.
    expect(result!.sql).toContain("-- leading comment\n");
    expect(result!.sql).toContain("\n/* between */ ");
    expect(result!.sql.endsWith("\n-- trailing")).toBe(true);
    expect(result!.statements).toHaveLength(2);
  });

  it("falls back to no batch pagination when any statement fails to plan", async () => {
    const prepare = vi.fn(async (request: QueryPaginationExecutionPlanOptions) => {
      if (request.sql.includes("t2")) throw new Error("parser choked");
      return plan();
    });
    const result = await prepareBatchQueryPagination(options(), prepare);
    expect(result).toBeUndefined();
  });

  it("treats cancellation during planning as fatal instead of a fallback", async () => {
    const prepare = vi.fn(async () => {
      throw new Error("Query canceled");
    });
    await expect(prepareBatchQueryPagination(options(), prepare, undefined, () => true)).rejects.toThrow("Query canceled");
  });

  it("keeps statements whose planner returned the original SQL without a proven row bound", async () => {
    const prepare = vi.fn(async (request: QueryPaginationExecutionPlanOptions) => {
      if (request.sql.includes("t1")) return plan();
      // An unchanged statement with no exactQueryRowBound is a driver row cap,
      // not server pagination — the module must leave it byte-for-byte intact.
      return plan({ pageSql: request.sql, sqlToExecute: request.sql });
    });
    const result = await prepareBatchQueryPagination(options(), prepare);
    expect(result).toBeTruthy();
    expect(result!.statements[1]).toBeUndefined();
    expect(result!.sql).toContain("SELECT b FROM t2");
  });

  it("uses the probe SQL for mysql statements so page trimming stays possible", async () => {
    const prepare = vi.fn().mockResolvedValue(plan());
    const result = await prepareBatchQueryPagination(options({ databaseType: "mysql" }), prepare);
    expect(result).toBeTruthy();
    expect(result!.sql).toContain("LIMIT 21 OFFSET 0");
  });

  it("keeps mysql batches at the requested page size when no probe is offered (#13211)", async () => {
    const prepare = vi.fn().mockResolvedValue(plan({ pageProbeSql: undefined }));
    const result = await prepareBatchQueryPagination(options({ databaseType: "mysql" }), prepare);
    expect(result?.statements).toHaveLength(2);
    expect(result?.sql).toBe("SELECT id FROM t LIMIT 20 OFFSET 0; SELECT id FROM t LIMIT 20 OFFSET 0");
  });

  it("skips cursor sessions, sqlserver batches, and single statements", async () => {
    const prepare = vi.fn();
    expect(await prepareBatchQueryPagination(options({ useAgentCursor: true }), prepare)).toBeUndefined();
    expect(await prepareBatchQueryPagination(options({ databaseType: "sqlserver" }), prepare)).toBeUndefined();
    expect(await prepareBatchQueryPagination(options({ sql: "SELECT a FROM t1", queryBaseSql: "SELECT a FROM t1" }), prepare)).toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
  });
});
