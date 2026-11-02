import { describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";
import { captureOceanbaseDiagnosticTarget, collectOceanbaseSessionDiagnostics, parseOceanbaseCachedPlan } from "../oceanbaseSessionDiagnostics";
import type { SessionDiagnosticsSnapshot } from "../sessionDiagnostics";
import { DiagnosticReadStopped } from "../sessionDiagnosticReader";
import { mapOceanbaseSessions } from "../oracleSessionManagement";

const sqlId = "A".repeat(32),
  traceId = "trace-1";
const session = { id: "9007199254740993", user: "APP'X", tenant: "tenant_a", serverIp: "127.0.0.1", serverPort: "2882", proxySessionId: null };
const live = { SID: session.id, SESSION_USER: session.user, TENANT: session.tenant, SVR_IP: session.serverIp, SVR_PORT: "2882", PROXY_SESSID: null, DB_NAME: "APP", SQL_ID: sqlId, TRACE_ID: traceId, STATE: "ACTIVE", SQL_TEXT: "SELECT 42 FROM DUAL" };
const audit = {
  TENANT_ID: "9007199254740995",
  TENANT_NAME: session.tenant,
  SVR_IP: session.serverIp,
  SVR_PORT: "2882",
  SID: session.id,
  TRACE_ID: traceId,
  SQL_ID: sqlId,
  REQUEST_ID: "9007199254740997",
  REQUEST_TIME: "1792593313123456",
  SQL_EXEC_ID: "9007199254740999",
  PLAN_ID: "9007199254741001",
  RET_CODE: "0",
  EVENT: "db file read",
  WAIT_CLASS: "USER_IO",
  STATE: "WAITED SHORT TIME",
  QUERY_SQL: "SELECT 42 FROM DUAL",
  ELAPSED_TIME: "0",
  RETURN_ROWS: "9007199254741003",
};
const planStat = { TENANT_ID: audit.TENANT_ID, SVR_IP: session.serverIp, SVR_PORT: "2882", PLAN_ID: audit.PLAN_ID, SQL_ID: sqlId, FIRST_LOAD_TIME: "2026-10-21 20:00:00 +08:00", PLAN_HASH: "9007199254741005", EXECUTIONS: "9007199254741007", ELAPSED_TIME: "2000000", APPLICATION_WATI_TIME: "17" };
const planRows = [
  { PLAN_DEPTH: "0", PLAN_LINE_ID: "0", OPERATOR: "PHY_SCALAR_AGGREGATE", NAME: "NULL", ESTIMATED_ROWS: "1", COST: "0", PROPERTY: null },
  { PLAN_DEPTH: "1", PLAN_LINE_ID: "1", OPERATOR: " PHY_TABLE_SCAN", NAME: "T", ESTIMATED_ROWS: "0", COST: "0", PROPERTY: "filter(T.X > 1)" },
];
function result(rows: Record<string, unknown>[], extra: Partial<QueryResult> = {}): QueryResult {
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { columns, rows: rows.map((row) => columns.map((column) => row[column] as string | number | null)), affected_rows: 0, execution_time_ms: 1, ...extra };
}
function fixture(
  options: {
    audits?: Record<string, unknown>[];
    planAfter?: Record<string, unknown>;
    auditError?: string;
    explainError?: string;
    liveErrorOnCollect?: string;
    changeAfterLongops?: boolean;
    changeBeforeLongops?: boolean;
    longops?: Record<string, unknown>[];
    longopsTruncated?: boolean;
    requireLongopsPredicate?: boolean;
  } = {},
) {
  let liveReads = 0,
    planReads = 0;
  const query = vi.fn(async (sql: string) => {
    if (sql.includes(" AS NOW_US")) return result([{ NOW_US: "1792593313000000" }]);
    if (sql.includes("FROM SYS.GV$OB_PROCESSLIST")) {
      liveReads++;
      if (liveReads > 1 && options.liveErrorOnCollect) throw new Error(options.liveErrorOnCollect);
      return result([{ ...live, ...((options.changeBeforeLongops && liveReads >= 3) || (options.changeAfterLongops && liveReads >= 4) ? { TRACE_ID: "trace-next" } : {}) }]);
    }
    if (sql.includes("FROM SYS.GV$OB_SQL_AUDIT")) {
      if (options.auditError) throw new Error(options.auditError);
      return result(options.audits ?? [audit]);
    }
    if (sql.includes("FROM SYS.GV$OB_SESS_TIME_MODEL")) return result([{ TENANT_ID: audit.TENANT_ID }]);
    if (sql.includes("FROM SYS.GV$OB_PLAN_CACHE_PLAN_STAT")) return result([++planReads > 1 && options.planAfter ? options.planAfter : planStat]);
    if (sql.includes("FROM SYS.GV$OB_PLAN_CACHE_PLAN_EXPLAIN")) {
      if (options.explainError) throw new Error(options.explainError);
      return result(planRows);
    }
    if (sql.includes("FROM SYS.GV$SESSION_LONGOPS")) {
      if (options.requireLongopsPredicate && !sql.includes(`WHERE (SID=${session.id} OR SID=-1) AND TRACE_ID='${traceId}' AND SVR_IP='${session.serverIp}' AND SVR_PORT=2882`)) return result([]);
      return result(options.longops ?? [], { truncated: options.longopsTruncated });
    }
    throw new Error(`Unexpected diagnostic query: ${sql}`);
  });
  const reader = { query, readCell: vi.fn(async (value: QueryResult, row: number, column: number) => String(value.rows[row]?.[column] ?? "")), stop: vi.fn(), close: vi.fn(), closed: Promise.resolve(), cleanupError: undefined };
  const snapshot: Partial<SessionDiagnosticsSnapshot> = {};
  const publish = (patch: Partial<SessionDiagnosticsSnapshot>) => Object.assign(snapshot, patch);
  return { reader, query, snapshot, publish };
}

describe("OceanBase session-linked diagnostics", () => {
  it("rejects a reused list session before sampling its replacement SQL or trace", async () => {
    const [selected] = mapOceanbaseSessions({ rows: [[session.id, session.user, session.tenant, "host", "APP", "Query", "0", "ACTIVE", "original SQL", null, session.serverIp, session.serverPort, sqlId, "original-trace"]] });
    const f = fixture();
    await expect(captureOceanbaseDiagnosticTarget(selected!, f.reader)).rejects.toThrow("Selected session SQL changed");
    expect(f.reader.readCell).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledOnce();
  });

  it("binds the captured trace to its exact request and cached plan without executing the target", async () => {
    const f = fixture();
    const target = await captureOceanbaseDiagnosticTarget(session, f.reader);
    await collectOceanbaseSessionDiagnostics(target, f.reader, f.publish);
    expect(f.snapshot.identity).toMatchObject({ sid: session.id, requestId: audit.REQUEST_ID, tenantId: audit.TENANT_ID, returnCode: "0" });
    expect(f.snapshot.sql).toMatchObject({ state: "ready", data: { completeness: "unknown", text: "SELECT 42 FROM DUAL" } });
    expect(f.snapshot.plan).toMatchObject({ state: "ready", data: { binding: "request", plan: { databaseType: "oceanbase-oracle" } } });
    expect(f.snapshot.metrics?.data).toContainEqual(expect.objectContaining({ name: "elapsed", value: "0", unit: "microseconds", scope: "request" }));
    expect(f.snapshot.metrics?.data).toContainEqual(expect.objectContaining({ name: "executions", value: planStat.EXECUTIONS, scope: "plan_cumulative" }));
    expect(f.snapshot.longOperations).toMatchObject({ state: "empty", reason: "not_collected" });
    const auditSql = f.query.mock.calls.find(([sql]) => sql.includes("FROM SYS.GV$OB_SQL_AUDIT"))?.[0] ?? "";
    expect(auditSql).toContain(`SID=${session.id}`);
    expect(auditSql).toContain("TENANT_NAME='tenant_a'");
    expect(auditSql).toContain(`TRACE_ID='${traceId}'`);
    expect(auditSql).toContain("REQUEST_TIME BETWEEN 1792506913000000 AND 1792593314000000");
    expect(f.query.mock.calls.every(([sql]) => sql.startsWith("SELECT "))).toBe(true);
    expect(f.query.mock.calls.some(([sql]) => sql === live.SQL_TEXT)).toBe(false);
  });

  it("does not automatically choose one of multiple requests, and marks a same-SQL plan as unbound", async () => {
    const f = fixture({ audits: [audit, { ...audit, REQUEST_ID: "9007199254741011" }] });
    const target = await captureOceanbaseDiagnosticTarget(session, f.reader);
    await collectOceanbaseSessionDiagnostics(target, f.reader, f.publish);
    expect(target.request).toBeUndefined();
    expect(f.snapshot.requestChoices).toHaveLength(2);
    expect(f.snapshot.plan?.data?.binding).toBe("same_sql");
    expect(f.snapshot.metrics?.data?.every((metric) => metric.scope === "plan_cumulative")).toBe(true);
  });

  it("preserves an audit permission failure beside available cache statistics", async () => {
    const f = fixture({ auditError: "ORA-01031: insufficient privileges" });
    const target = await captureOceanbaseDiagnosticTarget(session, f.reader);
    await collectOceanbaseSessionDiagnostics(target, f.reader, f.publish);
    expect(f.snapshot.plan?.state).toBe("ready");
    expect(f.snapshot.metrics).toMatchObject({ state: "ready", reason: "permission_denied", error: expect.stringContaining("ORA-01031") });
  });

  it.each(["ORA-01031: insufficient privileges", "ORA-00942: inaccessible"])("preserves verified cache measurements when plan details fail with %s", async (explainError) => {
    for (const auditError of [undefined, "ORA-01031: audit denied"]) {
      const f = fixture({ explainError, auditError });
      const target = await captureOceanbaseDiagnosticTarget(session, f.reader);
      await collectOceanbaseSessionDiagnostics(target, f.reader, f.publish);
      expect(f.snapshot.plan).toMatchObject({ state: "unavailable", source: "SYS.GV$OB_PLAN_CACHE_PLAN_EXPLAIN", error: explainError });
      expect(f.snapshot.metrics).toMatchObject({ state: "ready" });
      expect(f.snapshot.metrics?.data).toContainEqual(expect.objectContaining({ name: "executions", value: planStat.EXECUTIONS, scope: "plan_cumulative" }));
      expect(f.snapshot.metrics?.data?.some((metric) => metric.scope === "request")).toBe(!auditError);
      if (auditError) expect(f.snapshot.metrics?.reason).toBe("permission_denied");
    }
  });

  it("does not publish cache measurements from a changed generation even when plan details failed", async () => {
    const f = fixture({ explainError: "ORA-01031: denied", planAfter: { ...planStat, FIRST_LOAD_TIME: "changed" } });
    const target = await captureOceanbaseDiagnosticTarget(session, f.reader);
    await collectOceanbaseSessionDiagnostics(target, f.reader, f.publish);
    expect(f.snapshot.plan).toMatchObject({ state: "unavailable", reason: "target_changed" });
    expect(f.snapshot.metrics?.data?.every((metric) => metric.scope === "request")).toBe(true);
  });

  it("keeps a bound original request readable when a later live-session read is unavailable", async () => {
    const f = fixture();
    const target = await captureOceanbaseDiagnosticTarget(session, f.reader);
    await collectOceanbaseSessionDiagnostics(target, f.reader, f.publish);
    const currentQuery = f.reader.query.getMockImplementation()!;
    f.reader.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM SYS.GV$OB_PROCESSLIST")) throw new Error("ORA-00942: inaccessible");
      return currentQuery(sql);
    });
    await collectOceanbaseSessionDiagnostics(target, f.reader, f.publish);
    expect(f.snapshot.identity?.requestId).toBe(audit.REQUEST_ID);
    expect(f.snapshot.waits?.state).toBe("ready");
    expect(f.snapshot.stale).toBe(true);
  });

  it("rejects a plan-generation change without replacing request measurements", async () => {
    const f = fixture({ planAfter: { ...planStat, FIRST_LOAD_TIME: "new-generation" } });
    const target = await captureOceanbaseDiagnosticTarget(session, f.reader);
    await collectOceanbaseSessionDiagnostics(target, f.reader, f.publish);
    expect(f.snapshot.plan).toMatchObject({ state: "unavailable", reason: "target_changed" });
    expect(f.snapshot.metrics?.data?.every((metric) => metric.scope === "request")).toBe(true);
  });

  it("does not attach long-operation results after the session switches trace", async () => {
    const f = fixture({ changeAfterLongops: true });
    const target = await captureOceanbaseDiagnosticTarget(session, f.reader);
    await collectOceanbaseSessionDiagnostics(target, f.reader, f.publish);
    expect(f.snapshot.stale).toBe(true);
    expect(f.snapshot.longOperations).toMatchObject({ state: "unavailable", reason: "target_changed" });
  });

  it("keeps positive and missing SID tasks separately trace-bound under the same tenant and node", async () => {
    const row = { SID: session.id, TRACE_ID: traceId, SVR_IP: session.serverIp, SVR_PORT: session.serverPort, OPNAME: "create index", TARGET: "table_id=42", ELAPSED_SECONDS: "2", TIME_REMAINING: "3" };
    const f = fixture({ longops: [row, { ...row, SID: "-1" }, { ...row, SID: "-1", TARGET: "table_id=43" }], requireLongopsPredicate: true, longopsTruncated: true });
    const target = await captureOceanbaseDiagnosticTarget(session, f.reader);
    await collectOceanbaseSessionDiagnostics(target, f.reader, f.publish);
    expect(f.snapshot.longOperations).toMatchObject({ state: "ready", incomplete: true });
    expect(f.snapshot.longOperations?.data?.columns[0]).toBe("SCOPE");
    expect(f.snapshot.longOperations?.data?.rows.map((values) => values.slice(0, 2))).toEqual([
      ["session_trace", session.id],
      ["request_trace", "-1"],
      ["request_trace", "-1"],
    ]);
    const calls = f.query.mock.calls.map(([sql]) => sql);
    const index = calls.findIndex((sql) => sql.includes("FROM SYS.GV$SESSION_LONGOPS"));
    expect(calls[index - 1]).toContain("FROM SYS.GV$OB_PROCESSLIST");
    expect(calls[index + 1]).toContain("FROM SYS.GV$OB_PROCESSLIST");
  });

  it("rejects missing, unrelated or malformed long-operation identities", async () => {
    const row = { SID: "-1", TRACE_ID: traceId, SVR_IP: session.serverIp, SVR_PORT: session.serverPort };
    for (const invalid of [{ SID: "0" }, { SID: null }, { SID: "-2" }, { SID: "21" }, { TRACE_ID: "other" }, { TRACE_ID: null }, { SVR_IP: "other-node" }, { SVR_PORT: "2883" }]) {
      const f = fixture({ longops: [{ ...row, ...invalid }], requireLongopsPredicate: true });
      const target = await captureOceanbaseDiagnosticTarget(session, f.reader);
      await collectOceanbaseSessionDiagnostics(target, f.reader, f.publish);
      expect(f.snapshot.longOperations).toMatchObject({ state: "unavailable", reason: "target_changed" });
      expect(f.snapshot.longOperations?.data).toBeUndefined();
    }
  });

  it("checks the original execution again immediately before reading long operations", async () => {
    const f = fixture({ changeBeforeLongops: true });
    const target = await captureOceanbaseDiagnosticTarget(session, f.reader);
    await collectOceanbaseSessionDiagnostics(target, f.reader, f.publish);
    expect(f.snapshot.longOperations).toMatchObject({ state: "unavailable", reason: "target_changed" });
    expect(f.query.mock.calls.some(([sql]) => sql.includes("FROM SYS.GV$SESSION_LONGOPS"))).toBe(false);
  });

  it("keeps the chosen cache generation fixed across refreshes", async () => {
    const f = fixture();
    const target = await captureOceanbaseDiagnosticTarget(session, f.reader);
    await collectOceanbaseSessionDiagnostics(target, f.reader, f.publish);
    const currentQuery = f.reader.query.getMockImplementation()!;
    f.reader.query.mockImplementation(async (sql: string) => (sql.includes("FROM SYS.GV$OB_PLAN_CACHE_PLAN_STAT") ? result([{ ...planStat, FIRST_LOAD_TIME: "new-generation" }]) : currentQuery(sql)));
    await collectOceanbaseSessionDiagnostics(target, f.reader, f.publish);
    expect(f.snapshot.plan).toMatchObject({ state: "unavailable", reason: "target_changed" });
    expect(target.plan?.firstLoadTime).toBe(planStat.FIRST_LOAD_TIME);
    expect(f.query.mock.calls.filter(([sql]) => sql.includes("FROM SYS.GV$OB_PLAN_CACHE_PLAN_EXPLAIN"))).toHaveLength(1);
  });

  it("rejects cross-tenant or duplicate request identities rather than choosing a first row", async () => {
    for (const audits of [[{ ...audit, TENANT_NAME: "other_tenant" }], [audit, audit]]) {
      const f = fixture({ audits });
      const target = await captureOceanbaseDiagnosticTarget(session, f.reader);
      await collectOceanbaseSessionDiagnostics(target, f.reader, f.publish, { requestKey: JSON.stringify([audit.TENANT_ID, audit.SVR_IP, audit.SVR_PORT, audit.SID, audit.TRACE_ID, audit.SQL_ID, audit.REQUEST_ID, audit.REQUEST_TIME, audit.SQL_EXEC_ID]) });
      expect(target.request).toBeUndefined();
      expect(f.snapshot.metrics?.data?.every((metric) => metric.scope !== "request")).toBe(true);
    }
  });

  it("does not continue with plan or long-operation queries after local cancellation", async () => {
    const f = fixture();
    const target = await captureOceanbaseDiagnosticTarget(session, f.reader);
    const currentQuery = f.reader.query.getMockImplementation()!;
    f.reader.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM SYS.GV$OB_SQL_AUDIT")) throw new DiagnosticReadStopped("cancelled");
      return currentQuery(sql);
    });
    await expect(collectOceanbaseSessionDiagnostics(target, f.reader, f.publish)).rejects.toMatchObject({ reason: "cancelled" });
    expect(f.query.mock.calls.some(([sql]) => /FROM SYS.GV\$OB_PLAN_CACHE|FROM SYS.GV\$SESSION_LONGOPS/.test(sql))).toBe(false);
  });

  it("does not query a cache without a unique tenant binding", async () => {
    const f = fixture({ audits: [] });
    const target = await captureOceanbaseDiagnosticTarget(session, f.reader);
    const currentQuery = f.reader.query.getMockImplementation()!;
    f.reader.query.mockImplementation(async (sql: string) => (sql.includes("FROM SYS.GV$OB_SESS_TIME_MODEL") ? result([{ TENANT_ID: "1002" }, { TENANT_ID: "1003" }]) : currentQuery(sql)));
    await collectOceanbaseSessionDiagnostics(target, f.reader, f.publish);
    expect(f.snapshot.plan).toMatchObject({ state: "unavailable", reason: "target_missing" });
    expect(f.query.mock.calls.some(([sql]) => sql.includes("FROM SYS.GV$OB_PLAN_CACHE"))).toBe(false);
  });

  it("keeps invalid or truncated tree rows as raw evidence without inventing hierarchy or actual rows", () => {
    const parsed = parseOceanbaseCachedPlan(result(planRows));
    expect(parsed.incomplete).toBe(false);
    expect(parsed.plan.nodes[0]?.children[0]).toMatchObject({ rows: "0", cost: "0", details: ["filter(T.X > 1)"] });
    expect(parseOceanbaseCachedPlan(result([{ ...planRows[0], PLAN_DEPTH: "2" }])).plan.nodes).toEqual([]);
    expect(parseOceanbaseCachedPlan(result(planRows, { truncated: true })).incomplete).toBe(true);
    for (const row of [
      { ...planRows[0], PLAN_LINE_ID: null },
      { ...planRows[1], PLAN_DEPTH: "invalid" },
    ]) {
      const raw = result([row]);
      expect(parseOceanbaseCachedPlan(raw)).toMatchObject({ incomplete: true, plan: { databaseType: "oceanbase-oracle", raw, nodes: [] } });
    }
  });

  it("uses numeric plan-line order after transport stringification", () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({ ...planRows[0], PLAN_LINE_ID: String(index), PLAN_DEPTH: index === 0 ? "0" : index === 1 ? "1" : index === 11 ? "3" : "2" }));
    rows.sort((left, right) => left.PLAN_LINE_ID.localeCompare(right.PLAN_LINE_ID));
    const parsed = parseOceanbaseCachedPlan(result(rows));
    expect(parsed.incomplete).toBe(false);
    expect(parsed.plan.nodes[0]?.children[0]?.children.map((node) => node.id)).toEqual(["2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(parsed.plan.nodes[0]?.children[0]?.children.at(-1)?.children[0]?.id).toBe("11");
  });
});
