import { describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";
import { collectOracleRuntimeDiagnostic, createRuntimeDiagnostics, type DiagnosticContext, type OracleDiagnosticTarget } from "../runtimeDiagnostics";

vi.mock("@/lib/backend/api", () => ({}));
const context: DiagnosticContext = { connectionId: "oracle-test", connectionName: "Dedicated test", database: "PDB1", engine: "oracle" };
const target: OracleDiagnosticTarget = { instanceId: "2", sqlId: "0123456789abc", childNumber: "1", childAddress: "0123456789ABCDEF", firstLoadTime: "2026-10-09/10:00:00", executions: "3", lastActiveTime: "2026-10-09T10:01:00" };
const cursor = { INST_ID: 2, SQL_ID: target.sqlId, CHILD_NUMBER: 1, CHILD_ADDRESS: target.childAddress, FIRST_LOAD_TIME: target.firstLoadTime, EXECUTIONS: 3, USERS_EXECUTING: 0, LAST_ACTIVE_TIME: target.lastActiveTime, ROWS_PROCESSED: 18, ELAPSED_TIME: 4500, USER_IO_WAIT_TIME: 12 };
function result(rows: Record<string, unknown>[]): QueryResult {
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { columns, rows: rows.map((row) => columns.map((name) => row[name])), affected_rows: 0, execution_time_ms: 0 } as QueryResult;
}
function fixture() {
  const query = vi
    .fn()
    .mockResolvedValueOnce(result([{ VERSION: "19.23.0.0.0" }]))
    .mockResolvedValueOnce(result([cursor]))
    .mockResolvedValueOnce(result([{ STARTS: 3, OUTPUT_ROWS: 18 }]))
    .mockResolvedValueOnce(result([cursor]));
  return query;
}
describe("explicit Oracle runtime diagnostics", () => {
  it("preserves actual cumulative values and units, without executing target SQL", async () => {
    const query = fixture();
    const record = await collectOracleRuntimeDiagnostic(context, target, query);
    expect(record.status).toBe("collected");
    expect(record.engineVersion).toBe("19.23.0.0.0");
    expect(record.metrics).toContainEqual(expect.objectContaining({ name: "elapsed", value: "4500", unit: "microseconds", scope: "cursor_cumulative" }));
    expect(record.metrics).toContainEqual(expect.objectContaining({ name: "root_output_rows", value: "18" }));
    expect(record.metrics).toContainEqual(expect.objectContaining({ name: "disk_reads", value: null, missingReason: "not_collected" }));
    expect(query.mock.calls.every(([sql]) => /^SELECT /.test(sql))).toBe(true);
  });
  it.each([0, null])("does not invent actual rows when row-source statistics are missing (%s)", async (starts) => {
    const query = fixture();
    query
      .mockReset()
      .mockResolvedValueOnce(result([{ VERSION: "19" }]))
      .mockResolvedValueOnce(result([cursor]))
      .mockResolvedValueOnce(result([{ STARTS: starts, OUTPUT_ROWS: 900, CARDINALITY: 900 }]))
      .mockResolvedValueOnce(result([cursor]));
    expect((await collectOracleRuntimeDiagnostic(context, target, query)).metrics.find((metric) => metric.name === "root_output_rows")).toMatchObject({ value: null, missingReason: "not_collected" });
  });
  it.each([
    { ...cursor, EXECUTIONS: 4 },
    { ...cursor, CHILD_ADDRESS: "0000000000000000" },
    { ...cursor, INST_ID: 1 },
    { ...cursor, USERS_EXECUTING: 1 },
  ])("rejects a changed execution/cursor rather than misattributing it", async (changed) => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([{ VERSION: "19" }]))
      .mockResolvedValueOnce(result([cursor]))
      .mockResolvedValueOnce(result([{ STARTS: 3, OUTPUT_ROWS: 18 }]))
      .mockResolvedValueOnce(result([changed]));
    const record = await collectOracleRuntimeDiagnostic(context, target, query);
    expect(record).toMatchObject({ status: "target_changed", metrics: [], evidence: {} });
  });
  it.each([
    ["ORA-01031: denied", "permission_denied"],
    ["ORA-00904: bad column", "unsupported"],
    ["cancelled", "cancelled"],
    ["timed out", "timeout"],
  ])("classifies %s without persisting raw errors", async (message, expected) => {
    const record = await collectOracleRuntimeDiagnostic(context, target, vi.fn().mockRejectedValue(new Error(`${message} secret bind`)));
    expect(record.status).toBe(expected);
    expect(JSON.stringify(record)).not.toContain("secret bind");
  });
  it("records cursor eviction independently from a permissions error", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([{ VERSION: "19" }]))
      .mockResolvedValueOnce(result([]));
    expect((await collectOracleRuntimeDiagnostic(context, target, query)).status).toBe("target_not_found");
  });
  it("does not retain extra credentials or target SQL supplied by a caller", async () => {
    const record = await collectOracleRuntimeDiagnostic({ ...context, password: "credential" } as DiagnosticContext, { ...target, sql: "private SQL" } as OracleDiagnosticTarget, fixture());
    expect(JSON.stringify(record)).not.toMatch(/credential|private SQL/);
  });
  it("rejects invalid identities before any database call", async () => {
    const query = fixture();
    await expect(collectOracleRuntimeDiagnostic(context, { ...target, childNumber: "1 OR 1=1" }, query)).rejects.toThrow("Invalid cursor identity");
    expect(query).not.toHaveBeenCalled();
  });
});

describe("production query and history boundary", () => {
  it("uses bounded independent query executions and round trips the record through history", async () => {
    const record = await collectOracleRuntimeDiagnostic(context, target, fixture());
    const backend = { executeQuery: vi.fn().mockResolvedValue(result([cursor])), cancelQuery: vi.fn().mockResolvedValue(true), saveHistory: vi.fn(), searchHistory: vi.fn() };
    const service = createRuntimeDiagnostics(backend);
    expect(backend.executeQuery).not.toHaveBeenCalled();
    await service.findTargets(context, target.sqlId, new AbortController().signal);
    expect(backend.executeQuery).toHaveBeenCalledWith(context.connectionId, context.database, expect.any(String), undefined, expect.any(String), { maxRows: 101, timeoutSecs: 10 });
    await service.save(record);
    const entry = backend.saveHistory.mock.calls[0][0];
    expect(entry).toMatchObject({ sql: "", source: "other", operation: "runtime_diagnostic" });
    backend.searchHistory.mockResolvedValue({ entries: [entry], total: 1 });
    expect((await service.load(context)).records).toEqual([record]);
    expect((await service.load({ ...context, database: "other" })).records).toEqual([]);
  });
  it("cancels only its diagnostic request and starts no subsequent query", async () => {
    let resolve!: (value: QueryResult) => void;
    const backend = {
      executeQuery: vi.fn().mockImplementation(
        () =>
          new Promise<QueryResult>((done) => {
            resolve = done;
          }),
      ),
      cancelQuery: vi.fn().mockResolvedValue(true),
      saveHistory: vi.fn(),
      searchHistory: vi.fn(),
    };
    const controller = new AbortController();
    const collection = createRuntimeDiagnostics(backend).collect(context, target, controller.signal);
    controller.abort();
    resolve(result([{ VERSION: "19" }]));
    expect((await collection).status).toBe("cancelled");
    expect(backend.cancelQuery).toHaveBeenCalledWith(backend.executeQuery.mock.calls[0][4]);
    expect(backend.executeQuery).toHaveBeenCalledTimes(1);
  });
});
