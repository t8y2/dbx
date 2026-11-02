import type { ExplainPlanNode, ParsedExplainPlan } from "@/lib/diagram/explainPlan";
import type { QueryResult } from "@/types/database";
import type { ProcessRow } from "./processListDrivers";
import { oracleMajorVersion, ORACLE_SESSION_VERSION_SQL } from "./oracleSessionManagement";
import { DiagnosticReadStopped, type SessionDiagnosticReader } from "./sessionDiagnosticReader";
import { diagnosticFailure, diagnosticInteger, diagnosticLiteral, diagnosticResultComplete, diagnosticRows, diagnosticSection, diagnosticString, diagnosticUnavailable, type DiagnosticMetric, type DiagnosticPublish, type DiagnosticSection, type DiagnosticSql } from "./sessionDiagnostics";

const SESSION_SOURCE = "GV$SESSION",
  CURSOR_SOURCE = "GV$SQL",
  PLAN_SOURCE = "GV$SQL_PLAN",
  ROW_SOURCE = "GV$SQL_PLAN_STATISTICS_ALL",
  LONGOPS_SOURCE = "GV$SESSION_LONGOPS";
type Row = ReturnType<typeof diagnosticRows>[number];
interface OracleCursor {
  sqlId: string;
  childNumber: string;
  childAddress: string;
  firstLoadTime: string;
  planHash: string;
}
export interface OracleDiagnosticTarget {
  engine: "oracle";
  session: ProcessRow;
  legacy: boolean;
  sqlId: string;
  childNumber: string;
  sqlExecId: string;
  sqlExecStart: string;
  cursor?: OracleCursor;
  cursorError?: string;
  sql?: DiagnosticSection<DiagnosticSql>;
}
const COUNTERS = [
  ["executions", "EXECUTIONS", "count"],
  ["rows_processed", "ROWS_PROCESSED", "rows"],
  ["buffer_gets", "BUFFER_GETS", "count"],
  ["disk_reads", "DISK_READS", "count"],
  ["elapsed", "ELAPSED_TIME", "microseconds"],
  ["cpu", "CPU_TIME", "microseconds"],
  ["application_wait", "APPLICATION_WAIT_TIME", "microseconds"],
  ["concurrency_wait", "CONCURRENCY_WAIT_TIME", "microseconds"],
  ["cluster_wait", "CLUSTER_WAIT_TIME", "microseconds"],
  ["user_io_wait", "USER_IO_WAIT_TIME", "microseconds"],
] as const;

function containerPredicate(target: OracleDiagnosticTarget, alias: string): string {
  return target.legacy ? "" : ` AND ${alias}.CON_ID=${diagnosticInteger(target.session.container)}`;
}
function sessionWhere(target: OracleDiagnosticTarget, alias = "s"): string {
  const row = target.session;
  const user = diagnosticString(row.user),
    logon = diagnosticString(row.logonTime);
  if (!user || !logon) throw new Error("Incomplete Oracle session identity");
  return `${alias}.SID=${diagnosticInteger(row.id)} AND ${alias}.SERIAL#=${diagnosticInteger(row.serial)} AND ${alias}.INST_ID=${diagnosticInteger(row.instance)}${containerPredicate(target, alias)} AND ${alias}.USERNAME=${diagnosticLiteral(user)} AND ${alias}.AUDSID=${diagnosticInteger(row.auditSession)} AND TO_CHAR(${alias}.LOGON_TIME,'YYYY-MM-DD HH24:MI:SS')=${diagnosticLiteral(logon)}${target.legacy ? "" : ` AND ${alias}.CON_ID=TO_NUMBER(SYS_CONTEXT('USERENV','CON_ID'))`}`;
}
async function liveSession(target: OracleDiagnosticTarget, reader: SessionDiagnosticReader): Promise<Row | null> {
  const result = await reader.query(
    `SELECT s.SQL_ID,TO_CHAR(s.SQL_CHILD_NUMBER) AS CHILD_NUMBER,TO_CHAR(s.SQL_EXEC_ID) AS SQL_EXEC_ID,TO_CHAR(s.SQL_EXEC_START,'YYYY-MM-DD"T"HH24:MI:SS') AS SQL_EXEC_START,s.EVENT,s.WAIT_CLASS,s.STATE,TO_CHAR(s.SECONDS_IN_WAIT) AS SECONDS_IN_WAIT,TO_CHAR(s.BLOCKING_INSTANCE) AS BLOCKING_INSTANCE,TO_CHAR(s.BLOCKING_SESSION) AS BLOCKING_SESSION FROM ${SESSION_SOURCE} s WHERE ${sessionWhere(target)}`,
    2,
  );
  const rows = diagnosticRows(result);
  return rows.length === 1 && diagnosticResultComplete(result) ? rows[0] : null;
}
function executionMatches(target: OracleDiagnosticTarget, row: Row | null): boolean {
  return !!row && diagnosticString(row.SQL_ID) === target.sqlId && diagnosticString(row.CHILD_NUMBER) === target.childNumber && diagnosticString(row.SQL_EXEC_ID) === target.sqlExecId && diagnosticString(row.SQL_EXEC_START) === target.sqlExecStart;
}
function cursorWhere(target: OracleDiagnosticTarget, alias: string, includeGeneration: boolean): string {
  const where = `${alias}.INST_ID=${diagnosticInteger(target.session.instance)}${containerPredicate(target, alias)} AND ${alias}.SQL_ID=${diagnosticLiteral(target.sqlId)} AND ${alias}.CHILD_NUMBER=${diagnosticInteger(target.childNumber)}`;
  if (!includeGeneration || !target.cursor) return where;
  return `${where} AND RAWTOHEX(${alias}.CHILD_ADDRESS)=${diagnosticLiteral(target.cursor.childAddress)} AND ${alias}.PLAN_HASH_VALUE=${target.cursor.planHash}`;
}
function cursorIdentity(row: Row): OracleCursor {
  const sqlId = diagnosticString(row.SQL_ID),
    childAddress = diagnosticString(row.CHILD_ADDRESS),
    firstLoadTime = diagnosticString(row.FIRST_LOAD_TIME);
  if (!/^[a-z0-9]{13}$/.test(sqlId) || !/^[0-9A-Fa-f]{8,32}$/.test(childAddress) || !firstLoadTime) throw new Error("Invalid Oracle cursor identity");
  return { sqlId, childNumber: diagnosticInteger(row.CHILD_NUMBER), childAddress, firstLoadTime, planHash: diagnosticInteger(row.PLAN_HASH) };
}
function cursorKey(cursor: OracleCursor): string {
  return JSON.stringify([cursor.sqlId, cursor.childNumber, cursor.childAddress, cursor.firstLoadTime, cursor.planHash]);
}
const CURSOR_COLUMNS = "s.SQL_ID,TO_CHAR(s.CHILD_NUMBER) AS CHILD_NUMBER,RAWTOHEX(s.CHILD_ADDRESS) AS CHILD_ADDRESS,s.FIRST_LOAD_TIME,TO_CHAR(s.PLAN_HASH_VALUE) AS PLAN_HASH";
async function findCursor(target: OracleDiagnosticTarget, reader: SessionDiagnosticReader): Promise<OracleCursor | undefined> {
  if (!target.sqlId || !target.childNumber) return;
  const result = await reader.query(`SELECT ${CURSOR_COLUMNS} FROM ${CURSOR_SOURCE} s WHERE ${cursorWhere(target, "s", false)}`, 2);
  const rows = diagnosticRows(result);
  if (rows.length !== 1 || !diagnosticResultComplete(result)) return;
  const cursor = cursorIdentity(rows[0]);
  if (cursor.sqlId !== target.sqlId || cursor.childNumber !== target.childNumber) throw new Error("Oracle cursor identity changed");
  return cursor;
}

export async function captureOracleDiagnosticTarget(row: ProcessRow, versionMajor: number | undefined, reader: SessionDiagnosticReader): Promise<OracleDiagnosticTarget> {
  let major = versionMajor;
  if (!major) {
    const result = await reader.query(ORACLE_SESSION_VERSION_SQL, 2);
    if (result.rows.length !== 1 || !diagnosticResultComplete(result)) throw new Error("Oracle version unavailable");
    major = oracleMajorVersion(diagnosticString(result.rows[0][0])) ?? undefined;
  }
  if (!major || major < 11) throw new Error("Oracle session diagnostics require a verified Oracle 11g or newer version");
  const target: OracleDiagnosticTarget = { engine: "oracle", session: { ...row }, legacy: major < 12, sqlId: "", childNumber: "", sqlExecId: "", sqlExecStart: "" };
  const current = await liveSession(target, reader);
  if (!current) throw new Error("Selected session identity changed; refresh the session list");
  target.sqlId = diagnosticString(current.SQL_ID);
  target.childNumber = diagnosticString(current.CHILD_NUMBER);
  target.sqlExecId = diagnosticString(current.SQL_EXEC_ID);
  target.sqlExecStart = diagnosticString(current.SQL_EXEC_START);
  if (target.sqlId && !/^[a-z0-9]{13}$/.test(target.sqlId)) throw new Error("Invalid Oracle SQL identity");
  if (target.childNumber) diagnosticInteger(target.childNumber);
  if (target.sqlExecId) diagnosticInteger(target.sqlExecId);
  if (row.sqlId !== undefined && diagnosticString(row.sqlId) !== target.sqlId) throw new Error("Selected session SQL changed; refresh the session list");
  try {
    target.cursor = await findCursor(target, reader);
  } catch (error) {
    if (error instanceof DiagnosticReadStopped) throw error;
    target.cursorError = error instanceof Error ? error.message : String(error);
  }
  return target;
}

function cursorMetrics(row: Row): DiagnosticMetric[] {
  return COUNTERS.map(([name, column, unit]) => ({ name, value: typeof row[column] === "string" && /^\d+(?:\.\d+)?$/.test(row[column]) ? row[column] : null, unit, scope: "cursor_cumulative", source: `${CURSOR_SOURCE}.${column}` }));
}
async function verifyCursor(target: OracleDiagnosticTarget, reader: SessionDiagnosticReader): Promise<boolean> {
  if (!target.cursor) return false;
  const current = await findCursor(target, reader);
  return !!current && cursorKey(current) === cursorKey(target.cursor);
}

async function readCursor(target: OracleDiagnosticTarget, reader: SessionDiagnosticReader, publish: DiagnosticPublish): Promise<DiagnosticMetric[] | null> {
  const source = `${CURSOR_SOURCE}.SQL_FULLTEXT`;
  const result = await reader.query(
    `SELECT ${CURSOR_COLUMNS},${COUNTERS.map(([, column]) => `TO_CHAR(s.${column}) AS ${column}`).join(",")},s.SQL_FULLTEXT AS SQL_TEXT,TO_CHAR(LENGTH(s.SQL_FULLTEXT)) AS SOURCE_LENGTH FROM ${CURSOR_SOURCE} s WHERE ${cursorWhere(target, "s", true)} AND s.FIRST_LOAD_TIME=${diagnosticLiteral(target.cursor!.firstLoadTime)}`,
    2,
  );
  const rows = diagnosticRows(result);
  if (rows.length !== 1 || !diagnosticResultComplete(result) || cursorKey(cursorIdentity(rows[0])) !== cursorKey(target.cursor!)) {
    publish({ sql: diagnosticUnavailable(source, "target_missing"), metrics: diagnosticUnavailable(CURSOR_SOURCE, "target_missing") });
    return null;
  }
  const row = rows[0];
  let sql: DiagnosticSection<DiagnosticSql>;
  try {
    const column = result.columns.findIndex((name) => name.toUpperCase() === "SQL_TEXT");
    if (column < 0) throw new Error("Oracle SQL text column unavailable");
    const text = await reader.readCell(result, 0, column);
    const expected = diagnosticInteger(row.SOURCE_LENGTH);
    sql = diagnosticSection(source, { text, completeness: BigInt(text.length) === BigInt(expected) ? "complete" : "fragment" }, BigInt(text.length) !== BigInt(expected));
  } catch (error) {
    const failed = diagnosticFailure<DiagnosticSql>(source, error);
    sql = { ...diagnosticSection(source, { text: diagnosticString(row.SQL_TEXT), completeness: "fragment" as const }, true), reason: failed.reason, error: failed.error };
  }
  if (!(await verifyCursor(target, reader))) {
    publish({ sql: diagnosticUnavailable(source, "target_changed"), metrics: diagnosticUnavailable(CURSOR_SOURCE, "target_changed") });
    return null;
  }
  target.sql = sql;
  const measured = cursorMetrics(row);
  publish({ sql, metrics: diagnosticSection(CURSOR_SOURCE, measured) });
  return measured;
}

export function parseOracleCachedPlan(result: QueryResult): { plan: ParsedExplainPlan; incomplete: boolean } {
  const records = diagnosticRows(result),
    nodes = new Map<string, ExplainPlanNode>(),
    parents = new Map<string, string>();
  if (!records.length || records.some((row) => typeof row.ID !== "string" || !/^\d+$/.test(row.ID) || (row.PARENT_ID !== null && (typeof row.PARENT_ID !== "string" || !/^\d+$/.test(row.PARENT_ID)))))
    return { plan: { databaseType: "oracle", raw: result, nodes: [] }, incomplete: records.length > 0 || !diagnosticResultComplete(result) };
  let incomplete = !diagnosticResultComplete(result);
  for (const row of records) {
    const id = diagnosticInteger(row.ID),
      parent = row.PARENT_ID === null ? "" : diagnosticInteger(row.PARENT_ID);
    if (nodes.has(id) || (!parent && id !== "0") || parent === id) {
      incomplete = true;
      break;
    }
    const operation = [diagnosticString(row.OPERATION), diagnosticString(row.OPTIONS)].filter(Boolean).join(" ");
    if (!operation) {
      incomplete = true;
      break;
    }
    const name = [diagnosticString(row.OBJECT_OWNER), diagnosticString(row.OBJECT_NAME)].filter(Boolean).join(".");
    const index = /INDEX/.test(diagnosticString(row.OBJECT_TYPE)) || /INDEX/.test(operation);
    nodes.set(id, {
      id,
      nodeType: operation,
      title: name ? `${operation} on ${name}` : operation,
      dialect: "oracle",
      relation: !index && name ? name : undefined,
      index: index && name ? name : undefined,
      cost: row.COST === null ? undefined : diagnosticString(row.COST),
      rows: row.ESTIMATED_ROWS === null ? undefined : diagnosticString(row.ESTIMATED_ROWS),
      costModel: "unknown",
      details: [row.ACCESS_PREDICATES ? `Access: ${row.ACCESS_PREDICATES}` : "", row.FILTER_PREDICATES ? `Filter: ${row.FILTER_PREDICATES}` : ""].filter(Boolean),
      children: [],
    });
    parents.set(id, parent);
  }
  for (const [id, parent] of parents) {
    if (!parent) continue;
    const owner = nodes.get(parent);
    if (!owner) {
      incomplete = true;
      break;
    }
    owner.children.push(nodes.get(id)!);
  }
  for (const node of nodes.values()) node.children.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const root = nodes.get("0"),
    visited = new Set<string>(),
    queue = root ? [root] : [];
  while (queue.length && !incomplete) {
    const node = queue.shift()!;
    if (visited.has(node.id)) {
      incomplete = true;
      break;
    }
    visited.add(node.id);
    queue.push(...node.children);
  }
  if (visited.size !== nodes.size || !root) incomplete = true;
  return { plan: { databaseType: "oracle", raw: result, nodes: incomplete ? [] : [root!] }, incomplete };
}

async function readPlan(target: OracleDiagnosticTarget, reader: SessionDiagnosticReader, publish: DiagnosticPublish): Promise<void> {
  const result = await reader.query(
    `SELECT TO_CHAR(p.ID) AS ID,TO_CHAR(p.PARENT_ID) AS PARENT_ID,p.OPERATION,p.OPTIONS,p.OBJECT_OWNER,p.OBJECT_NAME,p.OBJECT_TYPE,TO_CHAR(p.COST) AS COST,TO_CHAR(p.CARDINALITY) AS ESTIMATED_ROWS,p.ACCESS_PREDICATES,p.FILTER_PREDICATES FROM ${PLAN_SOURCE} p WHERE ${cursorWhere(target, "p", true)} ORDER BY p.ID`,
    501,
  );
  if (!(await verifyCursor(target, reader))) {
    publish({ plan: diagnosticUnavailable(PLAN_SOURCE, "target_changed") });
    return;
  }
  const parsed = parseOracleCachedPlan(result);
  publish({ plan: { ...diagnosticSection(PLAN_SOURCE, { plan: parsed.plan, table: result, binding: "cursor" as const }, parsed.incomplete), ...(result.rows.length ? {} : { state: "empty" as const, reason: "not_collected" as const }) } });
}

async function readRowCounters(target: OracleDiagnosticTarget, reader: SessionDiagnosticReader, publish: DiagnosticPublish, measured: DiagnosticMetric[]): Promise<void> {
  const result = await reader.query(`SELECT TO_CHAR(p.STARTS) AS STARTS,TO_CHAR(p.OUTPUT_ROWS) AS OUTPUT_ROWS FROM ${ROW_SOURCE} p WHERE ${cursorWhere(target, "p", true)} AND p.ID=0`, 2);
  const rows = diagnosticRows(result);
  if (rows.length > 1 || !diagnosticResultComplete(result) || !(await verifyCursor(target, reader))) throw new Error("Row-source identity changed");
  const starts = rows[0]?.STARTS,
    output = rows[0]?.OUTPUT_ROWS;
  const collected = typeof starts === "string" && /^\d+$/.test(starts) && BigInt(starts) > 0n;
  const metric: DiagnosticMetric = { name: "root_output_rows", value: collected && typeof output === "string" && /^\d+$/.test(output) ? output : null, unit: "rows", scope: "cursor_cumulative", source: `${ROW_SOURCE}.OUTPUT_ROWS (ID=0)` };
  publish({ metrics: { ...diagnosticSection(`${CURSOR_SOURCE}; ${ROW_SOURCE}`, [...measured, metric]), ...(!collected ? { reason: "not_collected" as const } : {}) } });
}

export function oracleLongOperationProgress(sofar: unknown, total: unknown, units: unknown): string | null {
  if (typeof sofar !== "string" || typeof total !== "string" || !/^\d+$/.test(sofar) || !/^\d+$/.test(total) || !units || BigInt(total) === 0n) return null;
  return (Number(BigInt(sofar) >= BigInt(total) ? 1000n : (BigInt(sofar) * 1000n) / BigInt(total)) / 10).toString();
}

async function readLongOperations(target: OracleDiagnosticTarget, reader: SessionDiagnosticReader, publish: DiagnosticPublish): Promise<void> {
  const executionBound = !!target.sqlId && !!target.sqlExecId && !!target.sqlExecStart;
  const executionWhere = executionBound ? ` AND l.SQL_ID=${diagnosticLiteral(target.sqlId)} AND l.SQL_EXEC_ID=${diagnosticInteger(target.sqlExecId)} AND TO_CHAR(l.SQL_EXEC_START,'YYYY-MM-DD"T"HH24:MI:SS')=${diagnosticLiteral(target.sqlExecStart)}` : "";
  const result = await reader.query(
    `SELECT TO_CHAR(l.SID) AS SID,TO_CHAR(l.SERIAL#) AS SERIAL_NUMBER,TO_CHAR(l.INST_ID) AS INSTANCE_ID,l.OPNAME,l.TARGET,TO_CHAR(l.SOFAR) AS SOFAR,TO_CHAR(l.TOTALWORK) AS TOTALWORK,l.UNITS,TO_CHAR(l.START_TIME,'YYYY-MM-DD"T"HH24:MI:SS') AS START_TIME,TO_CHAR(l.LAST_UPDATE_TIME,'YYYY-MM-DD"T"HH24:MI:SS') AS LAST_UPDATE_TIME,TO_CHAR(l.ELAPSED_SECONDS) AS ELAPSED_SECONDS,TO_CHAR(l.TIME_REMAINING) AS TIME_REMAINING,l.MESSAGE,l.SQL_ID,TO_CHAR(l.SQL_EXEC_ID) AS SQL_EXEC_ID,TO_CHAR(l.SQL_EXEC_START,'YYYY-MM-DD"T"HH24:MI:SS') AS SQL_EXEC_START FROM ${LONGOPS_SOURCE} l WHERE l.SID=${diagnosticInteger(target.session.id)} AND l.SERIAL#=${diagnosticInteger(target.session.serial)} AND l.INST_ID=${diagnosticInteger(target.session.instance)}${containerPredicate(target, "l")}${executionWhere} AND EXISTS (SELECT 1 FROM ${SESSION_SOURCE} s WHERE ${sessionWhere(target)}) ORDER BY l.START_TIME`,
    101,
  );
  if (!executionMatches(target, await liveSession(target, reader))) {
    publish({ stale: true, longOperations: diagnosticUnavailable(LONGOPS_SOURCE, "target_changed") });
    return;
  }
  const source = diagnosticRows(result);
  const data: QueryResult = { ...result, columns: ["SCOPE", ...result.columns, "PROGRESS_PERCENT"], rows: result.rows.map((row, index) => [executionBound ? "execution" : "session_sample", ...row, oracleLongOperationProgress(source[index].SOFAR, source[index].TOTALWORK, source[index].UNITS)]) };
  publish({ longOperations: { ...diagnosticSection(LONGOPS_SOURCE, data, !diagnosticResultComplete(result)), ...(result.rows.length ? {} : { state: "empty" as const, reason: "not_collected" as const }) } });
}

export async function collectOracleSessionDiagnostics(target: OracleDiagnosticTarget, reader: SessionDiagnosticReader, publish: DiagnosticPublish): Promise<void> {
  publish({
    engine: "oracle",
    identity: {
      sid: diagnosticString(target.session.id),
      serial: diagnosticString(target.session.serial),
      instance: diagnosticString(target.session.instance),
      container: diagnosticString(target.session.container),
      user: diagnosticString(target.session.user),
      sqlId: target.sqlId,
      childNumber: target.childNumber,
      sqlExecId: target.sqlExecId,
      sqlExecStart: target.sqlExecStart,
    },
    ...(target.sql ? { sql: target.sql } : {}),
  });
  let current: Row | null = null;
  try {
    current = await liveSession(target, reader);
    publish({ stale: !executionMatches(target, current) });
    if (executionMatches(target, current)) {
      publish({
        waits: diagnosticSection(SESSION_SOURCE, {
          columns: ["WAIT_KIND", "STATE", "EVENT", "WAIT_CLASS", "SECONDS_IN_WAIT", "BLOCKING_INSTANCE", "BLOCKING_SESSION"],
          rows: [[current!.STATE === "WAITING" ? "current_wait" : "last_wait", current!.STATE, current!.EVENT, current!.WAIT_CLASS, current!.SECONDS_IN_WAIT, current!.BLOCKING_INSTANCE, current!.BLOCKING_SESSION]],
          affected_rows: 0,
          execution_time_ms: 0,
        }),
      });
    } else publish({ waits: diagnosticUnavailable(SESSION_SOURCE, "target_changed") });
  } catch (error) {
    publish({ stale: true, waits: diagnosticFailure(SESSION_SOURCE, error) });
  }
  if (!target.cursor && executionMatches(target, current)) {
    try {
      target.cursor = await findCursor(target, reader);
    } catch (error) {
      if (error instanceof DiagnosticReadStopped) throw error;
      target.cursorError = error instanceof Error ? error.message : String(error);
    }
  }
  if (target.cursor) {
    let measured: DiagnosticMetric[] | null = null;
    try {
      measured = await readCursor(target, reader, publish);
    } catch (error) {
      publish({ sql: diagnosticFailure(`${CURSOR_SOURCE}.SQL_FULLTEXT`, error), metrics: diagnosticFailure(CURSOR_SOURCE, error) });
    }
    try {
      await readPlan(target, reader, publish);
    } catch (error) {
      publish({ plan: diagnosticFailure(PLAN_SOURCE, error) });
    }
    if (measured) {
      try {
        await readRowCounters(target, reader, publish, measured);
      } catch (error) {
        const failure = diagnosticFailure(ROW_SOURCE, error);
        publish({ metrics: { ...diagnosticSection(`${CURSOR_SOURCE}; ${ROW_SOURCE}`, measured), reason: failure.reason, error: failure.error } });
      }
    }
  } else {
    const unavailable = target.cursorError ? diagnosticFailure<never>(CURSOR_SOURCE, new Error(target.cursorError)) : diagnosticUnavailable<never>(CURSOR_SOURCE, target.sqlId ? "target_missing" : "not_collected");
    publish({ sql: unavailable, plan: unavailable, metrics: unavailable });
  }
  if (executionMatches(target, current)) {
    try {
      await readLongOperations(target, reader, publish);
    } catch (error) {
      publish({ longOperations: diagnosticFailure(LONGOPS_SOURCE, error) });
    }
  } else publish({ longOperations: diagnosticUnavailable(LONGOPS_SOURCE, "target_changed") });
}
