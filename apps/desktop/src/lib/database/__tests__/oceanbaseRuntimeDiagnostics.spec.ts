import { describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";
import { createRuntimeDiagnostics } from "../runtimeDiagnostics";
import { collectOceanBaseRuntimeDiagnostic, findOceanBaseDiagnosticTargets, type OceanBaseDiagnosticTarget } from "../oceanbaseRuntimeDiagnostics";
vi.mock("@/lib/backend/api", () => ({}));
const context = { connectionId: "ob", connectionName: "Dedicated", database: "SYS", engine: "oceanbase-oracle" as const };
const window = { fromMicros: "1791530000000000", toMicros: "1791533600000000" };
const target: OceanBaseDiagnosticTarget = { kind: "ob_request", sqlId: "0123456789ABCDEF0123456789ABCDEF", traceId: "YB42-0005-0-0", tenantId: "1002", serverIp: "127.0.0.1", serverPort: "2882", sessionId: "3221225473", requestId: "123456789012345678", requestTimeMicros: "1791530100000000", window };
const row = {
  SQL_ID: target.sqlId,
  TRACE_ID: target.traceId,
  TENANT_ID: target.tenantId,
  SVR_IP: target.serverIp,
  SVR_PORT: target.serverPort,
  SID: target.sessionId,
  REQUEST_ID: target.requestId,
  REQUEST_TIME: target.requestTimeMicros,
  RET_CODE: "0",
  ELAPSED_TIME: "4500",
  EXECUTE_TIME: "3100",
  QUEUE_TIME: "15",
  RETURN_ROWS: "6",
  USER_IO_WAIT_TIME: null,
};
function result(rows: Record<string, unknown>[]): QueryResult {
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { columns, rows: rows.map((entry) => columns.map((key) => entry[key])), affected_rows: 0, execution_time_ms: 0 } as QueryResult;
}
function query() {
  return vi
    .fn()
    .mockResolvedValueOnce(result([{ BANNER: "OceanBase 4.2.5.7" }]))
    .mockResolvedValueOnce(result([{ VALUE: "true" }]))
    .mockResolvedValueOnce(result([{ VALUE: "True" }]))
    .mockResolvedValueOnce(result([row]));
}
describe("explicit OceanBase audit diagnostics", () => {
  it("finds an exact trace within a bounded window without text matching or last-SQL lookup", async () => {
    const execute = query();
    expect(await findOceanBaseDiagnosticTargets(target.traceId, window, execute)).toEqual([target]);
    expect(execute.mock.calls[3][0]).toContain(`TRACE_ID = '${target.traceId}'`);
    expect(execute.mock.calls[3][0]).toContain(`REQUEST_TIME BETWEEN ${window.fromMicros} AND ${window.toMicros}`);
    expect(execute.mock.calls.every(([sql]) => /^SELECT /.test(sql) && !/QUERY_SQL|LAST_TRACE_ID/i.test(sql))).toBe(true);
  });
  it("preserves request identity and units; missing IO stays uncollected", async () => {
    const record = await collectOceanBaseRuntimeDiagnostic(context, target, query());
    expect(record.status).toBe("collected");
    expect(record.target).toEqual(target);
    expect(record.metrics).toContainEqual(expect.objectContaining({ name: "request_elapsed", value: "4500", unit: "microseconds", scope: "request" }));
    expect(record.metrics).toContainEqual(expect.objectContaining({ name: "return_rows", value: "6", scope: "request" }));
    expect(record.metrics).toContainEqual(expect.objectContaining({ name: "user_io_wait", value: null, missingReason: "not_collected" }));
    expect(record.metrics.some((metric) => metric.name === "root_output_rows")).toBe(false);
  });
  it.each(["TENANT_ID", "SVR_IP", "SID", "REQUEST_ID", "REQUEST_TIME"])("rejects a response from a different %s", async (field) => {
    const execute = query();
    execute
      .mockReset()
      .mockResolvedValueOnce(result([{ BANNER: "OceanBase 4.2.5.7" }]))
      .mockResolvedValueOnce(result([{ VALUE: "1" }]))
      .mockResolvedValueOnce(result([{ VALUE: "True" }]))
      .mockResolvedValueOnce(result([{ ...row, [field]: field === "SVR_IP" ? "127.0.0.2" : field === "REQUEST_TIME" ? "1791530100000001" : "2" }]));
    expect((await collectOceanBaseRuntimeDiagnostic(context, target, execute)).status).toBe("target_changed");
  });
  it("reports disabled auditing without enabling it", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce(result([{ BANNER: "OceanBase 4.2.5.7" }]))
      .mockResolvedValueOnce(result([{ VALUE: "0" }]))
      .mockResolvedValueOnce(result([{ VALUE: "True" }]));
    expect((await collectOceanBaseRuntimeDiagnostic(context, target, execute)).status).toBe("audit_disabled");
    expect(execute.mock.calls.every(([sql]) => /^SELECT /.test(sql))).toBe(true);
  });
  it.each([
    ["ORA-01031 secret", "permission_denied"],
    ["cancelled", "cancelled"],
    ["connection closed", "connection_changed"],
    ["ORA-00904", "unsupported"],
  ])("classifies %s without keeping raw error data", async (message, status) => {
    const record = await collectOceanBaseRuntimeDiagnostic(context, target, vi.fn().mockRejectedValue(new Error(message)));
    expect(record.status).toBe(status);
    expect(JSON.stringify(record)).not.toContain("secret");
  });
  it("does not issue queries unless diagnostics are explicitly invoked, and persists engine/scope on reopen", async () => {
    const backend = { executeQuery: vi.fn(), cancelQuery: vi.fn(), saveHistory: vi.fn(), searchHistory: vi.fn() };
    const service = createRuntimeDiagnostics(backend);
    expect(backend.executeQuery).not.toHaveBeenCalled();
    const record = await collectOceanBaseRuntimeDiagnostic(context, target, query());
    await service.save(record);
    backend.searchHistory.mockResolvedValue({ entries: [backend.saveHistory.mock.calls[0][0]], total: 1 });
    expect((await service.load(context)).records).toEqual([record]);
  });
  it("rejects an unbounded window before reading the database", async () => {
    const execute = vi.fn();
    await expect(findOceanBaseDiagnosticTargets(target.traceId, { fromMicros: "1", toMicros: "86400000002" }, execute)).rejects.toThrow("Invalid audit time window");
    expect(execute).not.toHaveBeenCalled();
  });
});
