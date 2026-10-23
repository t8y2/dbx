import type { ExplainPlanNode, ParsedExplainPlan } from "@/lib/diagram/explainPlan";
import type { QueryResult } from "@/types/database";
import type { ProcessRow } from "./processListDrivers";
import { DiagnosticReadStopped, type SessionDiagnosticReader } from "./sessionDiagnosticReader";
import {
  diagnosticFailure,
  diagnosticInteger,
  diagnosticLiteral,
  diagnosticResultComplete,
  diagnosticRows,
  diagnosticSection,
  diagnosticString,
  diagnosticUnavailable,
  type DiagnosticChoice,
  type DiagnosticMetric,
  type DiagnosticPlan,
  type DiagnosticPublish,
  type DiagnosticSection,
  type DiagnosticSelection,
  type DiagnosticSql,
} from "./sessionDiagnostics";

const PROCESS_SOURCE = "SYS.GV$OB_PROCESSLIST";
const AUDIT_SOURCE = "SYS.GV$OB_SQL_AUDIT";
const PLAN_SOURCE = "SYS.GV$OB_PLAN_CACHE_PLAN_STAT";
const EXPLAIN_SOURCE = "SYS.GV$OB_PLAN_CACHE_PLAN_EXPLAIN";
const LONGOPS_SOURCE = "SYS.GV$SESSION_LONGOPS";
const CLOCK_SQL = "SELECT TO_CHAR(ROUND((CAST(SYS_EXTRACT_UTC(SYSTIMESTAMP) AS DATE)-DATE '1970-01-01')*86400)*1000000) AS NOW_US FROM SYS.DUAL";
const DAY_US = 86_400_000_000n;
type Row = ReturnType<typeof diagnosticRows>[number];

interface AuditIdentity {
  tenantId: string;
  serverIp: string;
  serverPort: string;
  sid: string;
  traceId: string;
  sqlId: string;
  requestId: string;
  requestTime: string;
  sqlExecId: string;
  planId: string;
}
interface PlanIdentity {
  tenantId: string;
  serverIp: string;
  serverPort: string;
  planId: string;
  sqlId: string;
  firstLoadTime: string;
  planHash: string;
}
export interface OceanbaseDiagnosticTarget {
  engine: "oceanbase-oracle";
  session: ProcessRow;
  sqlId: string;
  traceId: string;
  database: string;
  info: string;
  infoError?: string;
  tenantId?: string;
  fromMicros: string;
  toMicros?: string;
  request?: AuditIdentity;
  plan?: PlanIdentity;
  sql?: DiagnosticSection<DiagnosticSql>;
}

function sessionWhere(row: ProcessRow): string {
  const sid = diagnosticInteger(row.id);
  const port = diagnosticInteger(row.serverPort);
  const user = diagnosticString(row.user),
    tenant = diagnosticString(row.tenant),
    server = diagnosticString(row.serverIp);
  if (!user || !tenant || !server) throw new Error("Incomplete OceanBase session identity");
  const proxy = row.proxySessionId === null || row.proxySessionId === undefined || row.proxySessionId === "" ? "IS NULL" : `= ${diagnosticInteger(row.proxySessionId)}`;
  return `ID=${sid} AND "USER"=${diagnosticLiteral(user)} AND TENANT=${diagnosticLiteral(tenant)} AND SVR_IP=${diagnosticLiteral(server)} AND SVR_PORT=${port} AND PROXY_SESSID ${proxy}`;
}

async function liveSession(target: ProcessRow, reader: SessionDiagnosticReader) {
  const result = await reader.query(
    `SELECT TO_CHAR(ID) AS SID,"USER" AS SESSION_USER,TENANT,SVR_IP,TO_CHAR(SVR_PORT) AS SVR_PORT,TO_CHAR(PROXY_SESSID) AS PROXY_SESSID,DB AS DB_NAME,SQL_ID,TRACE_ID,STATE,INFO AS SQL_TEXT FROM ${PROCESS_SOURCE} WHERE ${sessionWhere(target)} AND TENANT=(SELECT TENANT FROM SYS.GV$OB_SESSION WHERE ID=SYS_CONTEXT('USERENV','SID') AND "USER"=SYS_CONTEXT('USERENV','SESSION_USER') AND ROWNUM=1)`,
    2,
  );
  const rows = diagnosticRows(result);
  return { result, row: rows.length === 1 && diagnosticResultComplete(result) ? rows[0] : null };
}

function sameSql(target: OceanbaseDiagnosticTarget, row: Row | null): boolean {
  return !!row && diagnosticString(row.SQL_ID) === target.sqlId && diagnosticString(row.TRACE_ID) === target.traceId;
}

async function databaseMicros(reader: SessionDiagnosticReader): Promise<bigint> {
  const result = await reader.query(CLOCK_SQL, 2);
  const rows = diagnosticRows(result);
  if (rows.length !== 1 || !diagnosticResultComplete(result)) throw new Error("Database clock unavailable");
  return BigInt(diagnosticInteger(rows[0].NOW_US));
}

export async function captureOceanbaseDiagnosticTarget(row: ProcessRow, reader: SessionDiagnosticReader): Promise<OceanbaseDiagnosticTarget> {
  const session = { ...row };
  const observed = await liveSession(session, reader);
  if (!observed.row) throw new Error("Selected session identity changed; refresh the session list");
  const current = observed.row;
  const sqlId = diagnosticString(current.SQL_ID),
    traceId = diagnosticString(current.TRACE_ID);
  if (sqlId && !/^[a-fA-F0-9]{32}$/.test(sqlId)) throw new Error("Invalid OceanBase SQL identity");
  if (traceId && !/^[A-Za-z0-9_:-]{1,128}$/.test(traceId)) throw new Error("Invalid OceanBase trace identity");
  if ((row.sqlId !== undefined && diagnosticString(row.sqlId) !== sqlId) || (row.traceId !== undefined && diagnosticString(row.traceId) !== traceId)) throw new Error("Selected session SQL changed; refresh the session list");
  const index = observed.result.columns.findIndex((column) => column.toUpperCase() === "SQL_TEXT");
  let info = diagnosticString(current.SQL_TEXT),
    infoError: string | undefined;
  if (index >= 0) {
    try {
      info = await reader.readCell(observed.result, 0, index);
    } catch (error) {
      if (error instanceof DiagnosticReadStopped) throw error;
      infoError = error instanceof Error ? error.message : String(error);
    }
  }
  const now = sqlId && traceId ? await databaseMicros(reader) : 0n;
  return { engine: "oceanbase-oracle", session, sqlId, traceId, database: diagnosticString(current.DB_NAME), info, infoError, fromMicros: (now > DAY_US ? now - DAY_US : 0n).toString() };
}

function auditIdentity(row: Row): AuditIdentity {
  return {
    tenantId: diagnosticInteger(row.TENANT_ID),
    serverIp: diagnosticString(row.SVR_IP),
    serverPort: diagnosticInteger(row.SVR_PORT),
    sid: diagnosticInteger(row.SID),
    traceId: diagnosticString(row.TRACE_ID),
    sqlId: diagnosticString(row.SQL_ID),
    requestId: diagnosticInteger(row.REQUEST_ID),
    requestTime: diagnosticInteger(row.REQUEST_TIME),
    sqlExecId: diagnosticInteger(row.SQL_EXEC_ID),
    planId: diagnosticInteger(row.PLAN_ID),
  };
}
function auditKey(row: AuditIdentity): string {
  return JSON.stringify([row.tenantId, row.serverIp, row.serverPort, row.sid, row.traceId, row.sqlId, row.requestId, row.requestTime, row.sqlExecId]);
}
function nodeWhere(target: OceanbaseDiagnosticTarget): string {
  return `SVR_IP=${diagnosticLiteral(diagnosticString(target.session.serverIp))} AND SVR_PORT=${diagnosticInteger(target.session.serverPort)}`;
}
function auditWhere(target: OceanbaseDiagnosticTarget, bound?: AuditIdentity): string {
  const base = `TENANT_NAME=${diagnosticLiteral(diagnosticString(target.session.tenant))} AND ${nodeWhere(target)} AND SID=${diagnosticInteger(target.session.id)} AND TRACE_ID=${diagnosticLiteral(target.traceId)} AND SQL_ID=${diagnosticLiteral(target.sqlId)} AND IS_INNER_SQL=0 AND IS_EXECUTOR_RPC=0`;
  if (bound) return `${base} AND TENANT_ID=${bound.tenantId} AND REQUEST_ID=${bound.requestId} AND REQUEST_TIME=${bound.requestTime} AND SQL_EXEC_ID=${bound.sqlExecId}`;
  return base + (target.tenantId ? ` AND TENANT_ID=${target.tenantId}` : "");
}
const AUDIT_COLUMNS =
  "TO_CHAR(TENANT_ID) AS TENANT_ID,TENANT_NAME,SVR_IP,TO_CHAR(SVR_PORT) AS SVR_PORT,TO_CHAR(SID) AS SID,TRACE_ID,SQL_ID,TO_CHAR(REQUEST_ID) AS REQUEST_ID,TO_CHAR(REQUEST_TIME) AS REQUEST_TIME,TO_CHAR(SQL_EXEC_ID) AS SQL_EXEC_ID,TO_CHAR(PLAN_ID) AS PLAN_ID,TO_CHAR(RET_CODE) AS RET_CODE,EVENT,WAIT_CLASS,STATE,QUERY_SQL";
const REQUEST_METRICS = [
  ["elapsed", "ELAPSED_TIME", "microseconds"],
  ["execute", "EXECUTE_TIME", "microseconds"],
  ["queue", "QUEUE_TIME", "microseconds"],
  ["total_wait", "TOTAL_WAIT_TIME_MICRO", "microseconds"],
  ["application_wait", "APPLICATION_WAIT_TIME", "microseconds"],
  ["concurrency_wait", "CONCURRENCY_WAIT_TIME", "microseconds"],
  ["user_io_wait", "USER_IO_WAIT_TIME", "microseconds"],
  ["rows_processed", "RETURN_ROWS", "rows"],
  ["disk_reads", "DISK_READS", "count"],
] as const;
const PLAN_METRICS = [
  ["executions", "EXECUTIONS", "count"],
  ["rows_processed", "ROWS_PROCESSED", "rows"],
  ["buffer_gets", "BUFFERS_GETS", "count"],
  ["disk_reads", "DISK_READS", "count"],
  ["elapsed", "ELAPSED_TIME", "microseconds"],
  ["cpu", "CPU_TIME", "microseconds"],
  ["application_wait", "APPLICATION_WATI_TIME", "microseconds"],
  ["concurrency_wait", "CONCURRENCY_WAIT_TIME", "microseconds"],
  ["user_io_wait", "USER_IO_WAIT_TIME", "microseconds"],
] as const;
function metricColumns(definitions: readonly (readonly [string, string, string])[]): string {
  return definitions.map(([, column]) => `TO_CHAR(${column}) AS ${column}`).join(",");
}
function metrics(row: Row, definitions: readonly (readonly [string, string, DiagnosticMetric["unit"]])[], source: string, scope: DiagnosticMetric["scope"]): DiagnosticMetric[] {
  return definitions.map(([name, column, unit]) => ({ name, value: typeof row[column] === "string" && /^\d+(?:\.\d+)?$/.test(row[column]) ? row[column] : null, unit, scope, source: `${source}.${column}` }));
}

async function readAudit(target: OceanbaseDiagnosticTarget, reader: SessionDiagnosticReader, publish: DiagnosticPublish, selection: DiagnosticSelection): Promise<{ row: Row | null; issue?: DiagnosticSection<DiagnosticMetric[]> }> {
  const bound = selection.requestKey && target.request && selection.requestKey !== auditKey(target.request) ? undefined : target.request;
  let window = "";
  if (!bound) {
    target.toMicros = ((await databaseMicros(reader)) + 1_000_000n).toString();
    window = ` AND REQUEST_TIME BETWEEN ${target.fromMicros} AND ${target.toMicros}`;
  }
  publish({ identity: { auditFromMicros: target.fromMicros, ...(target.toMicros ? { auditToMicros: target.toMicros } : {}) } });
  const result = await reader.query(`SELECT ${AUDIT_COLUMNS},${metricColumns(REQUEST_METRICS)} FROM ${AUDIT_SOURCE} WHERE ${auditWhere(target, bound)}${window} ORDER BY REQUEST_TIME,REQUEST_ID`, 101);
  const rows = diagnosticRows(result);
  const identities = rows.map(auditIdentity);
  if (
    identities.some(
      (identity, index) =>
        identity.sid !== diagnosticInteger(target.session.id) ||
        identity.sqlId !== target.sqlId ||
        identity.traceId !== target.traceId ||
        identity.serverIp !== target.session.serverIp ||
        identity.serverPort !== diagnosticInteger(target.session.serverPort) ||
        diagnosticString(rows[index].TENANT_NAME) !== target.session.tenant ||
        (target.tenantId && identity.tenantId !== target.tenantId) ||
        (bound && identity.planId !== bound.planId),
    )
  )
    throw new Error("Audit request identity changed");
  const incomplete = !diagnosticResultComplete(result) || rows.length > 100;
  const choices: DiagnosticChoice[] = identities.slice(0, 100).map((identity, index) => ({ key: auditKey(identity), identity: { requestId: identity.requestId, requestTime: identity.requestTime, sqlExecId: identity.sqlExecId, returnCode: diagnosticString(rows[index].RET_CODE) } }));
  if (!bound) publish({ requestChoices: choices });
  let selected = bound ? identities.findIndex((identity) => auditKey(identity) === auditKey(bound)) : selection.requestKey ? identities.findIndex((identity) => auditKey(identity) === selection.requestKey) : rows.length === 1 && !incomplete ? 0 : -1;
  if (bound && (rows.length !== 1 || incomplete)) selected = -1;
  if (selected >= 0 && identities.filter((identity) => auditKey(identity) === auditKey(identities[selected])).length !== 1) selected = -1;
  if (selected < 0) {
    const issue = { ...diagnosticUnavailable<DiagnosticMetric[]>(AUDIT_SOURCE, bound ? "target_missing" : "not_collected"), incomplete };
    publish({ metrics: issue });
    return { row: null, issue };
  }
  const identity = identities[selected];
  if (target.request && auditKey(target.request) !== auditKey(identity)) target.plan = undefined;
  target.request = identity;
  target.tenantId = identity.tenantId;
  const row = rows[selected];
  const column = result.columns.findIndex((name) => name.toUpperCase() === "QUERY_SQL");
  if (column >= 0) {
    try {
      const text = await reader.readCell(result, selected, column);
      if (text) {
        target.sql = diagnosticSection(`${AUDIT_SOURCE}.QUERY_SQL`, { text, completeness: "unknown" });
        publish({ sql: target.sql });
      }
    } catch (error) {
      const failure = diagnosticFailure(AUDIT_SOURCE, error);
      publish({ sql: { ...(target.sql ?? diagnosticSection(`${PROCESS_SOURCE}.INFO`, { text: target.info, completeness: "fragment" as const }, true)), error: failure.error } });
    }
  }
  publish({
    identity: {
      sqlId: target.sqlId,
      traceId: target.traceId,
      tenant: diagnosticString(target.session.tenant),
      tenantId: identity.tenantId,
      server: `${identity.serverIp}:${identity.serverPort}`,
      sid: identity.sid,
      requestId: identity.requestId,
      requestTime: identity.requestTime,
      sqlExecId: identity.sqlExecId,
      returnCode: diagnosticString(row.RET_CODE),
    },
  });
  return { row };
}

function planIdentity(row: Row): PlanIdentity {
  return {
    tenantId: diagnosticInteger(row.TENANT_ID),
    serverIp: diagnosticString(row.SVR_IP),
    serverPort: diagnosticInteger(row.SVR_PORT),
    planId: diagnosticInteger(row.PLAN_ID),
    sqlId: diagnosticString(row.SQL_ID),
    firstLoadTime: diagnosticString(row.FIRST_LOAD_TIME),
    planHash: diagnosticInteger(row.PLAN_HASH),
  };
}
function planKey(identity: PlanIdentity): string {
  return JSON.stringify([identity.tenantId, identity.serverIp, identity.serverPort, identity.planId, identity.sqlId, identity.firstLoadTime, identity.planHash]);
}
const PLAN_COLUMNS = `TO_CHAR(TENANT_ID) AS TENANT_ID,SVR_IP,TO_CHAR(SVR_PORT) AS SVR_PORT,TO_CHAR(PLAN_ID) AS PLAN_ID,SQL_ID,TO_CHAR(FIRST_LOAD_TIME) AS FIRST_LOAD_TIME,TO_CHAR(PLAN_HASH) AS PLAN_HASH,${metricColumns(PLAN_METRICS)}`;

export function parseOceanbaseCachedPlan(result: QueryResult): { plan: ParsedExplainPlan; incomplete: boolean } {
  const roots: ExplainPlanNode[] = [],
    stack: ExplainPlanNode[] = [];
  const ids = new Set<string>();
  let incomplete = !diagnosticResultComplete(result);
  const records = diagnosticRows(result);
  if (records.some((row) => [row.PLAN_LINE_ID, row.PLAN_DEPTH].some((value) => typeof value !== "string" || !/^\d+$/.test(value)))) return { plan: { databaseType: "oceanbase-oracle", raw: result, nodes: [] }, incomplete: true };
  const ordered = records.sort((left, right) => {
    const a = BigInt(diagnosticInteger(left.PLAN_LINE_ID)),
      b = BigInt(diagnosticInteger(right.PLAN_LINE_ID));
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const row of ordered) {
    const id = diagnosticInteger(row.PLAN_LINE_ID),
      rawDepth = diagnosticInteger(row.PLAN_DEPTH);
    if (BigInt(rawDepth) > BigInt(result.rows.length) || ids.has(id)) {
      incomplete = true;
      break;
    }
    const depth = Number(rawDepth);
    if (depth > stack.length || (roots.length > 0 && depth === 0) || (roots.length === 0 && (depth !== 0 || id !== "0"))) {
      incomplete = true;
      break;
    }
    const operation = diagnosticString(row.OPERATOR).trim();
    if (!operation) {
      incomplete = true;
      break;
    }
    const rawName = diagnosticString(row.NAME),
      name = rawName === "NULL" ? "" : rawName;
    const node: ExplainPlanNode = {
      id,
      nodeType: operation,
      title: name ? `${operation} on ${name}` : operation,
      dialect: "oceanbase-oracle",
      relation: name || undefined,
      cost: row.COST === null ? undefined : diagnosticString(row.COST),
      rows: row.ESTIMATED_ROWS === null ? undefined : diagnosticString(row.ESTIMATED_ROWS),
      costModel: "unknown",
      details: row.PROPERTY ? [diagnosticString(row.PROPERTY)] : [],
      children: [],
    };
    ids.add(id);
    stack.length = depth;
    if (depth === 0) roots.push(node);
    else stack[depth - 1].children.push(node);
    stack.push(node);
  }
  return { plan: { databaseType: "oceanbase-oracle", raw: result, nodes: incomplete ? [] : roots }, incomplete };
}

async function readPlan(target: OceanbaseDiagnosticTarget, reader: SessionDiagnosticReader, publish: DiagnosticPublish, selection: DiagnosticSelection, requestMetrics: DiagnosticMetric[], requestIssue?: DiagnosticSection<DiagnosticMetric[]>): Promise<void> {
  if (!target.tenantId) {
    const mapping = await reader.query(`SELECT DISTINCT TO_CHAR(TENANT_ID) AS TENANT_ID FROM SYS.GV$OB_SESS_TIME_MODEL WHERE SID=${diagnosticInteger(target.session.id)} AND ${nodeWhere(target)}`, 2);
    const rows = diagnosticRows(mapping);
    if (rows.length !== 1 || !diagnosticResultComplete(mapping)) {
      publish({ plan: diagnosticUnavailable(PLAN_SOURCE, "target_missing") });
      return;
    }
    target.tenantId = diagnosticInteger(rows[0].TENANT_ID);
  }
  const where = `TENANT_ID=${target.tenantId} AND ${nodeWhere(target)} AND SQL_ID=${diagnosticLiteral(target.sqlId)}`;
  const result = await reader.query(`SELECT ${PLAN_COLUMNS} FROM ${PLAN_SOURCE} WHERE ${where}${target.request ? ` AND PLAN_ID=${target.request.planId}` : ""} ORDER BY PLAN_ID`, 101);
  const rows = diagnosticRows(result),
    identities = rows.map(planIdentity);
  if (identities.some((identity) => identity.tenantId !== target.tenantId || identity.serverIp !== target.session.serverIp || identity.serverPort !== diagnosticInteger(target.session.serverPort) || identity.sqlId !== target.sqlId || !identity.firstLoadTime))
    throw new Error("Cached plan identity changed");
  const incomplete = !diagnosticResultComplete(result) || rows.length > 100;
  publish({ planChoices: identities.slice(0, 100).map((identity) => ({ key: planKey(identity), identity: { planId: identity.planId, planHash: identity.planHash, firstLoadTime: identity.firstLoadTime } })) });
  const selectedKey = selection.planKey ?? (target.plan ? planKey(target.plan) : undefined);
  const index = selectedKey ? identities.findIndex((identity) => planKey(identity) === selectedKey) : rows.length === 1 && !incomplete ? 0 : -1;
  if (index < 0 || (target.request && (rows.length !== 1 || incomplete))) {
    publish({ plan: { ...diagnosticUnavailable(PLAN_SOURCE, target.plan && rows.length ? "target_changed" : rows.length ? "not_collected" : "target_missing"), incomplete } });
    return;
  }
  const chosen = identities[index];
  const exact = `${where} AND PLAN_ID=${chosen.planId}`;
  let raw: QueryResult | undefined;
  let planFailure: DiagnosticSection<DiagnosticPlan> | undefined;
  try {
    raw = await reader.query(
      `SELECT TO_CHAR(PLAN_DEPTH) AS PLAN_DEPTH,TO_CHAR(PLAN_LINE_ID) AS PLAN_LINE_ID,OPERATOR,NAME,TO_CHAR("ROWS") AS ESTIMATED_ROWS,TO_CHAR(COST) AS COST,PROPERTY FROM ${EXPLAIN_SOURCE} p WHERE TENANT_ID=${chosen.tenantId} AND ${nodeWhere(target)} AND PLAN_ID=${chosen.planId} ORDER BY p.PLAN_LINE_ID`,
      501,
    );
  } catch (error) {
    planFailure = diagnosticFailure(EXPLAIN_SOURCE, error);
  }
  const after = await reader.query(`SELECT ${PLAN_COLUMNS} FROM ${PLAN_SOURCE} WHERE ${exact}`, 2);
  const afterRows = diagnosticRows(after);
  if (afterRows.length !== 1 || !diagnosticResultComplete(after) || planKey(planIdentity(afterRows[0])) !== planKey(chosen)) {
    publish({ plan: diagnosticUnavailable(PLAN_SOURCE, "target_changed") });
    return;
  }
  target.plan = chosen;
  publish({
    metrics: {
      ...diagnosticSection(`${requestMetrics.length || requestIssue ? `${AUDIT_SOURCE}; ` : ""}${PLAN_SOURCE}`, [...requestMetrics, ...metrics(rows[index], PLAN_METRICS, PLAN_SOURCE, "plan_cumulative")]),
      ...(requestIssue ? { reason: requestIssue.reason, error: requestIssue.error, incomplete: requestIssue.incomplete } : {}),
    },
  });
  if (planFailure) publish({ plan: planFailure });
  else if (raw) {
    const parsed = parseOceanbaseCachedPlan(raw);
    publish({ plan: { ...diagnosticSection(EXPLAIN_SOURCE, { plan: parsed.plan, table: raw, binding: target.request ? ("request" as const) : ("same_sql" as const) }, parsed.incomplete), ...(raw.rows.length === 0 ? { state: "empty" as const, reason: "not_collected" as const } : {}) } });
  }
}

export async function collectOceanbaseSessionDiagnostics(target: OceanbaseDiagnosticTarget, reader: SessionDiagnosticReader, publish: DiagnosticPublish, selection: DiagnosticSelection = {}): Promise<void> {
  if (selection.requestKey && target.request && selection.requestKey !== auditKey(target.request)) {
    target.request = undefined;
    target.plan = undefined;
    target.sql = undefined;
  }
  publish({
    engine: target.engine,
    identity: { sid: diagnosticString(target.session.id), user: diagnosticString(target.session.user), tenant: diagnosticString(target.session.tenant), server: `${target.session.serverIp}:${target.session.serverPort}`, sqlId: target.sqlId, traceId: target.traceId },
    sql: target.sql ?? (target.info ? { ...diagnosticSection(`${PROCESS_SOURCE}.INFO`, { text: target.info, completeness: "fragment" as const }), error: target.infoError } : diagnosticUnavailable(`${PROCESS_SOURCE}.INFO`, "not_collected")),
  });
  let before: { row: Row | null } = { row: null };
  let liveFailure: DiagnosticSection<QueryResult> | undefined;
  try {
    before = await liveSession(target.session, reader);
  } catch (error) {
    liveFailure = diagnosticFailure(PROCESS_SOURCE, error);
  }
  const current = sameSql(target, before.row);
  publish({ stale: !current });
  if (before.row && current) {
    publish({ waits: diagnosticSection(PROCESS_SOURCE, { columns: ["STATE"], rows: [[before.row.STATE]], affected_rows: 0, execution_time_ms: 0 }) });
  } else publish({ waits: liveFailure ?? diagnosticUnavailable(PROCESS_SOURCE, "target_changed") });
  let requestMetrics: DiagnosticMetric[] = [];
  let requestIssue: DiagnosticSection<DiagnosticMetric[]> | undefined;
  if (target.sqlId && target.traceId) {
    try {
      const observed = await readAudit(target, reader, publish, selection);
      const audit = observed.row;
      requestIssue = observed.issue;
      if (audit) {
        requestMetrics = metrics(audit, REQUEST_METRICS, AUDIT_SOURCE, "request");
        publish({ metrics: diagnosticSection(AUDIT_SOURCE, requestMetrics) });
        publish({
          waits: {
            ...diagnosticSection(`${current || liveFailure ? `${PROCESS_SOURCE}; ` : ""}${AUDIT_SOURCE}`, {
              columns: ["SCOPE", "STATE", "EVENT", "WAIT_CLASS"],
              rows: [...(current && before.row ? [["session_sample", before.row.STATE, null, null]] : []), ["request", audit.STATE, audit.EVENT, audit.WAIT_CLASS]],
              affected_rows: 0,
              execution_time_ms: 0,
            }),
            ...(liveFailure ? { reason: liveFailure.reason, error: liveFailure.error } : {}),
          },
        });
      }
    } catch (error) {
      requestIssue = diagnosticFailure(AUDIT_SOURCE, error);
      publish({ metrics: requestIssue });
    }
  } else {
    requestIssue = diagnosticUnavailable(AUDIT_SOURCE, "not_collected");
    publish({ metrics: requestIssue });
  }
  if (target.sqlId) {
    try {
      await readPlan(target, reader, publish, selection, requestMetrics, requestIssue);
    } catch (error) {
      publish({ plan: diagnosticFailure(PLAN_SOURCE, error) });
    }
  } else publish({ plan: diagnosticUnavailable(PLAN_SOURCE, "not_collected") });
  if (!current || !target.traceId || !target.tenantId) {
    publish({ longOperations: diagnosticUnavailable(LONGOPS_SOURCE, current ? "not_collected" : "target_changed") });
    return;
  }
  try {
    const longopsBefore = await liveSession(target.session, reader);
    if (!sameSql(target, longopsBefore.row)) {
      publish({ stale: true, longOperations: diagnosticUnavailable(LONGOPS_SOURCE, "target_changed") });
      return;
    }
    const result = await reader.query(
      `SELECT TO_CHAR(SID) AS SID,TRACE_ID,OPNAME,TARGET,SVR_IP,TO_CHAR(SVR_PORT) AS SVR_PORT,TO_CHAR(START_TIME) AS START_TIME,TO_CHAR(ELAPSED_SECONDS) AS ELAPSED_SECONDS,TO_CHAR(TIME_REMAINING) AS TIME_REMAINING,TO_CHAR(LAST_UPDATE_TIME) AS LAST_UPDATE_TIME,MESSAGE FROM ${LONGOPS_SOURCE} WHERE (SID=${diagnosticInteger(target.session.id)} OR SID=-1) AND TRACE_ID=${diagnosticLiteral(target.traceId)} AND ${nodeWhere(target)} ORDER BY START_TIME`,
      101,
    );
    const after = await liveSession(target.session, reader);
    if (!sameSql(target, after.row)) {
      publish({ stale: true, longOperations: diagnosticUnavailable(LONGOPS_SOURCE, "target_changed") });
      return;
    }
    const rows = diagnosticRows(result);
    if (rows.some((row) => (row.SID !== "-1" && row.SID !== diagnosticInteger(target.session.id)) || row.TRACE_ID !== target.traceId || row.SVR_IP !== target.session.serverIp || row.SVR_PORT !== diagnosticInteger(target.session.serverPort))) {
      publish({ longOperations: diagnosticUnavailable(LONGOPS_SOURCE, "target_changed") });
      return;
    }
    const table = { ...result, columns: ["SCOPE", ...result.columns], rows: result.rows.map((row, index) => [rows[index].SID === "-1" ? "request_trace" : "session_trace", ...row]) };
    publish({ longOperations: { ...diagnosticSection(LONGOPS_SOURCE, table, !diagnosticResultComplete(result)), ...(result.rows.length === 0 ? { state: "empty" as const, reason: "not_collected" as const } : {}) } });
  } catch (error) {
    publish({ longOperations: diagnosticFailure(LONGOPS_SOURCE, error) });
  }
}
