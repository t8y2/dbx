import { formatError } from "@/lib/backend/errorUtils";
import type { QueryResult } from "@/types/database";
import { buildPgCancelQuerySql, buildPgTerminateSessionSql, pgCancelQueryResultError, pgTerminateSessionResultError } from "./postgresProcessList";

export const PG_ADMIN_CONTEXT_SQL = "SELECT current_setting('server_version_num')::integer AS version, pg_catalog.pg_backend_pid() AS pid, current_database() AS database";
export const PG_BLOCKING_SQL = `SELECT w.pid AS wait_pid, w.backend_start::text AS wait_backend_start,
       w.query_start::text AS wait_query_start, w.usename AS wait_user,
       w.datname AS wait_database, w.application_name AS wait_app,
       w.state AS wait_state, w.wait_event_type, w.wait_event,
       w.query AS wait_query, p.blocker_pid AS hold_pid,
       b.backend_start::text AS hold_backend_start, b.query_start::text AS hold_query_start,
       b.usename AS hold_user, b.datname AS hold_database,
       b.application_name AS hold_app, b.state AS hold_state, b.query AS hold_query
FROM pg_catalog.pg_stat_activity w
CROSS JOIN LATERAL (
  SELECT DISTINCT blocker_pid
  FROM unnest(pg_catalog.pg_blocking_pids(w.pid)) AS x(blocker_pid)
) p
LEFT JOIN pg_catalog.pg_stat_activity b ON b.pid = p.blocker_pid
ORDER BY w.pid, p.blocker_pid`;

export type PgBlockingRow = Record<string, string | number | boolean | null> & { wait_pid: number; hold_pid: number };
export function queryRecords(result: QueryResult): Record<string, string | number | boolean | null>[] {
  if (result.execution_error) throw new Error(result.error ? formatError(result.error) : String(result.rows[0]?.[0] ?? "Query failed"));
  return result.rows.map((row) => Object.fromEntries(result.columns.map((name, index) => [name, row[index] ?? null])));
}
export function mapPgBlockingRows(result: QueryResult): PgBlockingRow[] {
  const pairs = new Map<string, PgBlockingRow>();
  for (const record of queryRecords(result)) {
    if (record.wait_pid === null || record.hold_pid === null) continue;
    const waiter = Number(record.wait_pid),
      blocker = Number(record.hold_pid);
    if (!Number.isSafeInteger(waiter) || waiter <= 0 || !Number.isSafeInteger(blocker) || blocker < 0) continue;
    pairs.set(`${waiter}:${blocker}`, { ...record, wait_pid: waiter, hold_pid: blocker });
  }
  return [...pairs.values()];
}
function pidSql(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid backend PID");
  return String(pid);
}
export function pgLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
export interface PgSessionIdentity {
  pid: number;
  backendStart: string;
  queryStart?: string | null;
}
/** Keep timestamp precision: identities are server text, never JS Date values. */
export function pgIdentityPredicate(target: PgSessionIdentity): string {
  if (!target.backendStart) throw new Error("Session identity unavailable");
  return `pid = ${pidSql(target.pid)} AND backend_start::text = ${pgLiteral(target.backendStart)}`;
}
export function buildPgSignalSql(target: PgSessionIdentity, action: "cancel" | "terminate"): string {
  const signal = (action === "cancel" ? buildPgCancelQuerySql : buildPgTerminateSessionSql)(target.pid).replace(/^SELECT /, "");
  const queryIdentity = action === "cancel" && target.queryStart ? ` AND query_start::text = ${pgLiteral(target.queryStart)}` : "";
  return `SELECT ${signal} FROM pg_catalog.pg_stat_activity WHERE ${pgIdentityPredicate(target)}${queryIdentity} AND pid <> pg_catalog.pg_backend_pid()`;
}
export function pgSignalResultError(result: QueryResult, action: "cancel" | "terminate"): string | null {
  queryRecords(result);
  if (result.rows.length === 0) return "postgresAdmin.targetChanged";
  return (action === "cancel" ? pgCancelQueryResultError : pgTerminateSessionResultError)([result]) ? "postgresAdmin.signalRejected" : null;
}
export function buildPgLockDetailsSql(target: PgSessionIdentity): string {
  return `SELECT l.pid, d.datname AS database, l.database AS database_oid, l.locktype,
       CASE WHEN l.database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()) OR l.database = 0
            THEN c.relname END AS relation,
       l.relation AS relation_oid, l.mode, l.granted, l.transactionid::text,
       l.virtualxid, l.page, l.tuple
FROM pg_catalog.pg_locks l
LEFT JOIN pg_catalog.pg_database d ON d.oid = l.database
LEFT JOIN pg_catalog.pg_class c ON c.oid = l.relation
  AND (l.database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()) OR l.database = 0)
WHERE l.pid = ${pidSql(target.pid)}
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE ${pgIdentityPredicate(target)})
ORDER BY l.granted, l.locktype, l.mode`;
}
export function blockingIdentity(row: PgBlockingRow, side: "wait" | "hold"): PgSessionIdentity | null {
  const pid = Number(row[`${side}_pid`]),
    start = row[`${side}_backend_start`];
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof start !== "string" || !start) return null;
  return { pid, backendStart: start, queryStart: row[`${side}_query_start`] as string | null };
}
