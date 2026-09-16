import type { QueryResult } from "@/types/database";
import { isMissingKingbaseSysFunction, isMissingKingbaseSysRelation } from "@/lib/database/kingbaseCatalogCompatibility";

/**
 * PostgreSQL "current activity / process list" helpers. Pure and framework-free
 * so they can be unit-tested in isolation; the generic panel component wires them
 * to the SQL bridge and the production-safety guard via the driver registry.
 *
 * The MySQL family lives in `./mysqlProcessList`; the generic, engine-agnostic
 * bits (coordinator, interval clamping, session counting) are shared from there.
 */

/**
 * One row per server-side backend. `now() - query_start` gives the age of the
 * currently running (or last) statement; we fall back to the transaction and
 * backend start so idle sessions still report a sensible age. Own session is
 * kept in the result set so the panel can dim it rather than hide it.
 */
export const PG_PROCESS_LIST_SQL = `SELECT pid,
       usename AS "user",
       datname AS db,
       coalesce(host(client_addr), client_hostname, 'local') AS client,
       application_name AS app,
       state,
       coalesce(nullif(wait_event_type, '') || ':' || wait_event, wait_event_type, '') AS wait,
       floor(extract(epoch FROM (now() - coalesce(query_start, xact_start, backend_start))))::bigint AS time,
       query
FROM pg_stat_activity
ORDER BY time DESC NULLS LAST`;

/** PostgreSQL 9.2-9.5 expose `waiting` instead of wait-event detail columns. */
export const PG_PROCESS_LIST_LEGACY_SQL = `SELECT pid,
       usename AS "user",
       datname AS db,
       coalesce(host(client_addr), client_hostname, 'local') AS client,
       application_name AS app,
       state,
       CASE WHEN waiting THEN 'Lock' ELSE '' END AS wait,
       floor(extract(epoch FROM (now() - coalesce(query_start, xact_start, backend_start))))::bigint AS time,
       query
FROM pg_stat_activity
ORDER BY time DESC NULLS LAST`;

/** openGauss exposes the legacy boolean `waiting` column rather than wait-event detail. */
export const OPENGAUSS_PROCESS_LIST_SQL = `SELECT pid,
       usename AS "user",
       datname AS db,
       coalesce(host(client_addr), client_hostname, 'local') AS client,
       application_name AS app,
       state,
       CASE WHEN waiting THEN 'Lock' ELSE '' END AS wait,
       CAST(floor(extract(epoch FROM (CURRENT_TIMESTAMP - coalesce(query_start, xact_start, backend_start)))) AS BIGINT) AS time,
       query
FROM pg_catalog.pg_stat_activity
ORDER BY time DESC NULLS LAST`;

/**
 * KingbaseES uses sys_catalog. Numeric epoch subtraction works in both MySQL
 * and Oracle modes despite their different datetime subtraction rules.
 */
export const KINGBASE_PROCESS_LIST_SQL = `SELECT pid,
       usename AS "user",
       datname AS db,
       coalesce(CAST(client_addr AS VARCHAR), client_hostname, 'local') AS client,
       application_name AS app,
       state,
       coalesce(nullif(concat_ws(':', wait_event_type, wait_event), ''), '') AS wait,
       CAST(floor(
         extract(epoch FROM CAST(CURRENT_TIMESTAMP AS TIMESTAMP))
         - extract(epoch FROM CAST(coalesce(query_start, xact_start, backend_start) AS TIMESTAMP))
       ) AS BIGINT) AS time,
       query
FROM sys_catalog.sys_stat_activity
ORDER BY time DESC NULLS LAST`;

export const KINGBASE_PG_PROCESS_LIST_SQL = KINGBASE_PROCESS_LIST_SQL.replace("sys_catalog.sys_stat_activity", "pg_catalog.pg_stat_activity");

/** Scalar query that returns the viewer's own backend pid. */
export const PG_OWN_SESSION_SQL = "SELECT pg_backend_pid()";
export const OPENGAUSS_OWN_SESSION_SQL = "SELECT pg_backend_pid()";
export const KINGBASE_OWN_SESSION_SQL = "SELECT sys_backend_pid()";
export const KINGBASE_PG_OWN_SESSION_SQL = "SELECT pg_backend_pid()";

export interface PgProcessRow {
  id: number;
  user: string;
  db: string | null;
  client: string;
  app: string | null;
  state: string | null;
  wait: string | null;
  time: number;
  query: string | null;
}

function columnIndex(columns: string[], name: string): number {
  const target = name.toLowerCase();
  return columns.findIndex((column) => column.toLowerCase() === target);
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length === 0 ? null : text;
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Map a `pg_stat_activity` result into typed rows. Column names are matched
 * case-insensitively and any missing column degrades to an empty value rather
 * than throwing, so forks that rename or drop a column still render.
 */
export function mapPgProcessRows(result: QueryResult | null | undefined): PgProcessRow[] {
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) return [];
  const columns = result.columns;
  const pidIdx = columnIndex(columns, "pid");
  const userIdx = columnIndex(columns, "user");
  const dbIdx = columnIndex(columns, "db");
  const clientIdx = columnIndex(columns, "client");
  const appIdx = columnIndex(columns, "app");
  const stateIdx = columnIndex(columns, "state");
  const waitIdx = columnIndex(columns, "wait");
  const timeIdx = columnIndex(columns, "time");
  const queryIdx = columnIndex(columns, "query");

  const cell = (row: (string | number | boolean | null)[], idx: number) => (idx >= 0 ? row[idx] : null);

  return result.rows.map((row) => ({
    id: asNumber(cell(row, pidIdx)),
    user: asString(cell(row, userIdx)),
    db: asNullableString(cell(row, dbIdx)),
    client: asString(cell(row, clientIdx)),
    app: asNullableString(cell(row, appIdx)),
    state: asNullableString(cell(row, stateIdx)),
    wait: asNullableString(cell(row, waitIdx)),
    time: asNumber(cell(row, timeIdx)),
    query: asNullableString(cell(row, queryIdx)),
  }));
}

/**
 * Build a `SELECT pg_cancel_backend(<pid>)` statement. `pid` is validated as a
 * finite positive integer (never interpolated as free text) so there is no
 * injection path.
 */
function validateBackendPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid backend pid: ${pid}`);
  }
}

export function buildPgCancelQuerySql(pid: number): string {
  validateBackendPid(pid);
  return `SELECT pg_cancel_backend(${pid})`;
}

export function buildKingbaseCancelQuerySql(pid: number): string {
  validateBackendPid(pid);
  return `SELECT sys_cancel_backend(${pid})`;
}

export function buildKingbasePgCancelQuerySql(pid: number): string {
  validateBackendPid(pid);
  return `SELECT pg_cancel_backend(${pid})`;
}

/** Return an error when PostgreSQL reports that no running query was canceled. */
export function pgCancelQueryResultError(results: QueryResult[]): string | null {
  return backendCancelQueryResultError(results, "pg_cancel_backend");
}

export function kingbaseCancelQueryResultError(results: QueryResult[]): string | null {
  return backendCancelQueryResultError(results, "sys_cancel_backend");
}

export function kingbasePgCancelQueryResultError(results: QueryResult[]): string | null {
  return backendCancelQueryResultError(results, "pg_cancel_backend");
}

function backendCancelQueryResultError(results: QueryResult[], functionName: string): string | null {
  const result = results.find((item) => item.execution_error !== true);
  const value = result?.rows?.[0]?.[0];
  if (value === true || value === 1 || String(value).toLowerCase() === "t" || String(value).toLowerCase() === "true") return null;
  return `${functionName} did not cancel a running query`;
}

/** Detect the undefined-column failure produced by pre-9.6 pg_stat_activity. */
export function isPgProcessListCompatibilityError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (code === "42703") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:wait_event_type|wait_event).*(?:does not exist|42703)|(?:does not exist|42703).*(?:wait_event_type|wait_event)/i.test(message);
}

export function isKingbaseProcessListCatalogCompatibilityError(error: unknown): boolean {
  return isMissingKingbaseSysRelation(error, ["sys_catalog.sys_stat_activity"]);
}

export function isKingbaseOwnSessionCatalogCompatibilityError(error: unknown): boolean {
  return isMissingKingbaseSysFunction(error, ["sys_backend_pid"]);
}

export function isKingbaseCancelCatalogCompatibilityError(error: unknown): boolean {
  return isMissingKingbaseSysFunction(error, ["sys_cancel_backend"]);
}
