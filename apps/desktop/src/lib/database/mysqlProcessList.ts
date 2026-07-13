import type { DatabaseType, QueryResult } from "@/types/database";

/**
 * Engines that speak the MySQL protocol and support `SHOW FULL PROCESSLIST` /
 * `KILL CONNECTION`. MariaDB, TiDB, and OceanBase ride the `mysql` dbType via a
 * driver profile, so they are covered by the `"mysql"` entry.
 */
const PROCESS_LIST_DB_TYPES = new Set<DatabaseType>(["mysql"]);

/**
 * MySQL "current connections / process list" helpers. Pure and framework-free so
 * they can be unit-tested in isolation; the panel component wires them to the
 * generic SQL bridge and the production-safety guard.
 */

/**
 * `SHOW FULL PROCESSLIST` is available on every MySQL-family server without extra
 * privileges (it only reveals the caller's own sessions when PROCESS is missing),
 * and the backend already forces the correct text protocol for it. `FULL` keeps
 * the `Info` column from being truncated at 100 chars.
 */
export const PROCESS_LIST_SQL = "SHOW FULL PROCESSLIST";

/** Bounds for the auto-refresh interval, in seconds. */
export const MIN_REFRESH_SECONDS = 1;
export const MAX_REFRESH_SECONDS = 3600;
export const DEFAULT_REFRESH_SECONDS = 5;

export interface ProcessListLoadCoordinator {
  tryStart(): boolean;
  finish(): void;
}

export interface ProcessRow {
  id: number;
  user: string;
  host: string;
  db: string | null;
  command: string;
  time: number;
  state: string | null;
  info: string | null;
}

/**
 * Keep manual and timer-driven refreshes on the same single-flight guard. Slow
 * servers must not accumulate process-list queries faster than they complete.
 */
export function createProcessListLoadCoordinator(): ProcessListLoadCoordinator {
  let inFlight = false;
  return {
    tryStart() {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    finish() {
      inFlight = false;
    },
  };
}

/** Return the server-provided message for the first failed batch statement. */
export function processListExecutionError(results: QueryResult[]): string | null {
  const failed = results.find((result) => result.execution_error === true);
  if (!failed) return null;
  const message = failed.rows?.[0]?.[0];
  return message === null || message === undefined || String(message).length === 0 ? "Query execution failed" : String(message);
}

/** A truncated result only establishes a lower bound for the session count. */
export function processListSessionCount(count: number, truncated: boolean): number | string {
  return truncated ? `${count}+` : count;
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
 * Map a generic `SHOW FULL PROCESSLIST` result into typed rows. Column names are
 * matched case-insensitively because forks differ (e.g. `Id` vs `ID`), and any
 * missing column degrades to a sensible empty value rather than throwing.
 */
export function mapProcessRows(result: QueryResult | null | undefined): ProcessRow[] {
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) return [];
  const columns = result.columns;
  const idIdx = columnIndex(columns, "Id");
  const userIdx = columnIndex(columns, "User");
  const hostIdx = columnIndex(columns, "Host");
  const dbIdx = columnIndex(columns, "db");
  const commandIdx = columnIndex(columns, "Command");
  const timeIdx = columnIndex(columns, "Time");
  const stateIdx = columnIndex(columns, "State");
  const infoIdx = columnIndex(columns, "Info");

  const cell = (row: (string | number | boolean | null)[], idx: number) => (idx >= 0 ? row[idx] : null);

  return result.rows.map((row) => ({
    id: asNumber(cell(row, idIdx)),
    user: asString(cell(row, userIdx)),
    host: asString(cell(row, hostIdx)),
    db: asNullableString(cell(row, dbIdx)),
    command: asString(cell(row, commandIdx)),
    time: asNumber(cell(row, timeIdx)),
    state: asNullableString(cell(row, stateIdx)),
    info: asNullableString(cell(row, infoIdx)),
  }));
}

/**
 * Build the `KILL CONNECTION <id>` statement. `id` must be a finite integer; it
 * is validated (never interpolated as free text) so there is no injection path.
 */
export function buildKillSql(id: number): string {
  if (!Number.isInteger(id) || id < 0) {
    throw new Error(`Invalid session id: ${id}`);
  }
  return `KILL CONNECTION ${id}`;
}

/** Clamp a user-entered refresh interval to a safe integer range of seconds. */
export function clampInterval(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_REFRESH_SECONDS;
  const floored = Math.floor(seconds);
  if (floored < MIN_REFRESH_SECONDS) return MIN_REFRESH_SECONDS;
  if (floored > MAX_REFRESH_SECONDS) return MAX_REFRESH_SECONDS;
  return floored;
}

/** Whether the given database type exposes a process-list viewer (MySQL family). */
export function supportsProcessList(dbType: DatabaseType | undefined): boolean {
  return !!dbType && PROCESS_LIST_DB_TYPES.has(dbType);
}
