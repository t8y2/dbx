import { diagnosticErrorStatus, diagnosticRows, type DiagnosticContext, type DiagnosticMetric, type DiagnosticQuery, type RuntimeDiagnosticRecord } from "./runtimeDiagnostics";

export interface AuditWindow {
  fromMicros: string;
  toMicros: string;
}
export interface OceanBaseDiagnosticTarget {
  kind: "ob_request";
  sqlId: string;
  traceId: string;
  tenantId: string;
  serverIp: string;
  serverPort: string;
  sessionId: string;
  requestId: string;
  requestTimeMicros: string;
  window: AuditWindow;
}
const identityColumns = "SQL_ID, TRACE_ID, TO_CHAR(TENANT_ID) AS TENANT_ID, SVR_IP, TO_CHAR(SVR_PORT) AS SVR_PORT, TO_CHAR(SID) AS SID, TO_CHAR(REQUEST_ID) AS REQUEST_ID, TO_CHAR(REQUEST_TIME) AS REQUEST_TIME";
const metricDefinitions = [
  ["request_elapsed", "ELAPSED_TIME", "microseconds"],
  ["execute", "EXECUTE_TIME", "microseconds"],
  ["queue", "QUEUE_TIME", "microseconds"],
  ["total_wait", "TOTAL_WAIT_TIME_MICRO", "microseconds"],
  ["application_wait", "APPLICATION_WAIT_TIME", "microseconds"],
  ["concurrency_wait", "CONCURRENCY_WAIT_TIME", "microseconds"],
  ["user_io_wait", "USER_IO_WAIT_TIME", "microseconds"],
  ["return_rows", "RETURN_ROWS", "rows"],
  ["physical_reads", "DISK_READS", "count"],
] as const;
function value(raw: unknown): string {
  return raw == null ? "" : String(raw);
}
function validateWindow(window: AuditWindow | undefined): asserts window is AuditWindow {
  if (!window || !/^\d{1,20}$/.test(window.fromMicros) || !/^\d{1,20}$/.test(window.toMicros) || BigInt(window.fromMicros) >= BigInt(window.toMicros) || BigInt(window.toMicros) - BigInt(window.fromMicros) > 86_400_000_000n) throw new Error("Invalid audit time window (maximum 24 hours)");
}
function validateTrace(trace: string): void {
  if (!/^[A-Za-z0-9_:-]{1,128}$/.test(trace)) throw new Error("Invalid trace identity");
}
function targetFromRow(row: Record<string, unknown>, window: AuditWindow): OceanBaseDiagnosticTarget {
  const target: OceanBaseDiagnosticTarget = {
    kind: "ob_request",
    sqlId: value(row.SQL_ID),
    traceId: value(row.TRACE_ID),
    tenantId: value(row.TENANT_ID),
    serverIp: value(row.SVR_IP),
    serverPort: value(row.SVR_PORT),
    sessionId: value(row.SID),
    requestId: value(row.REQUEST_ID),
    requestTimeMicros: value(row.REQUEST_TIME),
    window: { ...window },
  };
  validateTarget(target);
  return target;
}
function validateTarget(target: OceanBaseDiagnosticTarget): void {
  validateTrace(target.traceId);
  validateWindow(target.window);
  if (
    !/^[A-Fa-f0-9]{32}$/.test(target.sqlId) ||
    !/^[A-Fa-f0-9:.]{1,46}$/.test(target.serverIp) ||
    [target.tenantId, target.serverPort, target.sessionId, target.requestId, target.requestTimeMicros].some((item) => !/^\d{1,20}$/.test(item)) ||
    BigInt(target.requestTimeMicros) < BigInt(target.window.fromMicros) ||
    BigInt(target.requestTimeMicros) > BigInt(target.window.toMicros)
  )
    throw new Error("Invalid audit request identity");
}
async function environment(query: DiagnosticQuery): Promise<string> {
  const versions = diagnosticRows(await query("SELECT BANNER FROM SYS.V$VERSION WHERE BANNER LIKE 'OceanBase%'"));
  const version = value(versions[0]?.BANNER);
  if (!/^OceanBase\s+[4-9]\./i.test(version)) throw new Error("Unsupported OceanBase audit version");
  const tenant = diagnosticRows(await query("SELECT VALUE FROM SYS.TENANT_VIRTUAL_GLOBAL_VARIABLE WHERE VARIABLE_NAME = 'ob_enable_sql_audit'"));
  const server = diagnosticRows(await query("SELECT VALUE FROM SYS.GV$OB_PARAMETERS WHERE NAME = 'enable_sql_audit'"));
  if ([...tenant, ...server].some((row) => /^(?:false|off|0)$/i.test(value(row.VALUE)))) throw new Error("Audit disabled");
  if (!tenant.length || !server.length || [...tenant, ...server].some((row) => !/^(?:true|on|1)$/i.test(value(row.VALUE)))) throw new Error("Unsupported audit configuration visibility");
  return version;
}
export async function findOceanBaseDiagnosticTargets(trace: string, window: AuditWindow | undefined, query: DiagnosticQuery): Promise<OceanBaseDiagnosticTarget[]> {
  validateTrace(trace);
  validateWindow(window);
  await environment(query);
  const rows = diagnosticRows(await query(`SELECT ${identityColumns} FROM SYS.GV$OB_SQL_AUDIT WHERE TRACE_ID = '${trace}' AND REQUEST_TIME BETWEEN ${window.fromMicros} AND ${window.toMicros} AND IS_EXECUTOR_RPC = 0 AND IS_INNER_SQL = 0 ORDER BY REQUEST_TIME, SVR_IP, REQUEST_ID`));
  if (rows.length > 100) throw new Error("Too many audit targets; narrow the time window");
  return rows.map((row) => targetFromRow(row, window));
}
export async function collectOceanBaseRuntimeDiagnostic(context: DiagnosticContext, target: OceanBaseDiagnosticTarget, query: DiagnosticQuery): Promise<RuntimeDiagnosticRecord> {
  validateTarget(target);
  const record: RuntimeDiagnosticRecord = {
    format: "dbx-runtime-diagnostic-v1",
    id: crypto.randomUUID(),
    context: { connectionId: context.connectionId, connectionName: context.connectionName, database: context.database, engine: "oceanbase-oracle" },
    target: targetFromRow({ SQL_ID: target.sqlId, TRACE_ID: target.traceId, TENANT_ID: target.tenantId, SVR_IP: target.serverIp, SVR_PORT: target.serverPort, SID: target.sessionId, REQUEST_ID: target.requestId, REQUEST_TIME: target.requestTimeMicros }, target.window),
    collectedAt: new Date().toISOString(),
    engineVersion: null,
    status: "not_collected",
    metrics: [],
    evidence: {},
  };
  try {
    record.engineVersion = await environment(query);
    const rows = diagnosticRows(
      await query(
        `SELECT ${identityColumns}, RET_CODE, ${metricDefinitions.map(([, column]) => `TO_CHAR(${column}) AS ${column}`).join(", ")} FROM SYS.GV$OB_SQL_AUDIT WHERE TRACE_ID = '${target.traceId}' AND TENANT_ID = ${target.tenantId} AND SVR_IP = '${target.serverIp}' AND SVR_PORT = ${target.serverPort} AND SID = ${target.sessionId} AND REQUEST_ID = ${target.requestId} AND REQUEST_TIME = ${target.requestTimeMicros} AND SQL_ID = '${target.sqlId}' AND IS_EXECUTOR_RPC = 0 AND IS_INNER_SQL = 0`,
      ),
    );
    if (rows.length !== 1) {
      record.status = "target_not_found";
      return record;
    }
    const observed = targetFromRow(rows[0], target.window);
    if (JSON.stringify(observed) !== JSON.stringify(record.target)) {
      record.status = "target_changed";
      return record;
    }
    record.evidence["GV$OB_SQL_AUDIT.RET_CODE"] = /^-?\d+$/.test(value(rows[0].RET_CODE)) ? value(rows[0].RET_CODE) : null;
    record.metrics = metricDefinitions.map(([name, column, unit]): DiagnosticMetric => {
      const raw = value(rows[0][column]);
      const measured = /^\d+(?:\.\d+)?$/.test(raw) ? raw : null;
      record.evidence[`GV$OB_SQL_AUDIT.${column}`] = measured;
      return { name, value: measured, unit, scope: "request", source: `GV$OB_SQL_AUDIT.${column}`, ...(measured === null ? { missingReason: "not_collected" as const } : {}) };
    });
    record.status = "collected";
  } catch (error) {
    record.status = diagnosticErrorStatus(error);
  }
  return record;
}
