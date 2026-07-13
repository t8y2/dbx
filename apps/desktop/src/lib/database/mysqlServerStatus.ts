import type { ConnectionConfig, DatabaseType, QueryResult } from "@/types/database";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";

/**
 * MySQL server-monitoring helpers. Pure and framework-free so the rate math and
 * formatting can be unit-tested; the dashboard component owns the polling loop
 * and ring buffer, and feeds samples through these functions.
 *
 * Data comes from `SHOW GLOBAL STATUS` (cumulative counters, two columns
 * Variable_name/Value) and a one-shot `SHOW GLOBAL VARIABLES` (config such as
 * max_connections/version), both run through the generic query bridge.
 */

export const GLOBAL_STATUS_SQL = "SHOW GLOBAL STATUS";
export const GLOBAL_VARIABLES_SQL = "SHOW GLOBAL VARIABLES";

/** Max samples retained for the live charts (~ a few minutes at 5s cadence). */
export const MAX_SAMPLES = 60;

/**
 * Engines with meaningful MySQL server-status counters (`SHOW GLOBAL STATUS`:
 * QPS, Com_*, Bytes_*, InnoDB). MariaDB, TiDB, and OceanBase ride the `mysql`
 * dbType via a driver profile, so they are covered by the `"mysql"` entry.
 *
 * Deliberately excludes the OLAP MySQL-protocol forks (Doris, StarRocks) — they
 * have no InnoDB and do not expose these status counters, so the dashboard would
 * be empty there. GoldenDB is excluded pending confirmation its proxy passes the
 * counters through.
 */
const SERVER_DASHBOARD_DB_TYPES = new Set<DatabaseType>(["mysql"]);

export type StatusMap = Record<string, string>;

export interface StatusSample {
  /** Capture time in epoch milliseconds (captured by the caller). */
  at: number;
  status: StatusMap;
}

/** A key/value row for the raw status table. */
export interface StatusEntry {
  name: string;
  value: string;
}

/** Parse a two-column `SHOW GLOBAL STATUS` / `SHOW GLOBAL VARIABLES` result. */
export function parseStatusResult(result: QueryResult | null | undefined): StatusMap {
  const map: StatusMap = {};
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) return map;
  const nameIdx = result.columns.findIndex((c) => c.toLowerCase() === "variable_name");
  const valueIdx = result.columns.findIndex((c) => c.toLowerCase() === "value");
  const nameCol = nameIdx >= 0 ? nameIdx : 0;
  const valueCol = valueIdx >= 0 ? valueIdx : 1;
  for (const row of result.rows) {
    const name = row[nameCol];
    if (name === null || name === undefined) continue;
    map[String(name)] = row[valueCol] === null || row[valueCol] === undefined ? "" : String(row[valueCol]);
  }
  return map;
}

/** Read a status value as a number, defaulting to 0 when absent/non-numeric. */
export function statusNumber(status: StatusMap, key: string): number {
  const raw = status[key];
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Per-second rate of a cumulative counter between two samples. Guards against a
 * counter reset (server restart / FLUSH STATUS) by treating a decrease as no
 * measurable rate, and against a zero/negative time delta.
 */
export function computeRate(prev: StatusSample, curr: StatusSample, key: string): number {
  const dtSeconds = (curr.at - prev.at) / 1000;
  if (dtSeconds <= 0) return 0;
  const delta = statusNumber(curr.status, key) - statusNumber(prev.status, key);
  if (delta < 0) return 0;
  return delta / dtSeconds;
}

/** QPS between two samples, preferring `Queries` and falling back to `Questions`. */
export function computeQps(prev: StatusSample, curr: StatusSample): number {
  const hasQueries = curr.status.Queries !== undefined;
  return computeRate(prev, curr, hasQueries ? "Queries" : "Questions");
}

/**
 * InnoDB buffer pool hit ratio (0-100) from cumulative reads vs read requests.
 * Returns null when the counters are unavailable (non-InnoDB / forks).
 */
export function innodbBufferHitRatio(status: StatusMap): number | null {
  const requests = statusNumber(status, "Innodb_buffer_pool_read_requests");
  if (requests <= 0) return null;
  const reads = statusNumber(status, "Innodb_buffer_pool_reads");
  const ratio = (1 - reads / requests) * 100;
  if (!Number.isFinite(ratio)) return null;
  return Math.max(0, Math.min(100, ratio));
}

/** Flatten a status map into sorted key/value rows for the raw table. */
export function statusEntries(status: StatusMap): StatusEntry[] {
  return Object.keys(status)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, value: status[name] }));
}

export function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), BYTE_UNITS.length - 1);
  const scaled = value / 1024 ** exponent;
  return `${scaled.toFixed(exponent === 0 ? 0 : 1)} ${BYTE_UNITS[exponent]}`;
}

export function formatBytesPerSec(value: number): string {
  return `${formatBytes(value)}/s`;
}

/** Format an uptime in seconds as a compact `Nd Nh Nm` / `Nh Nm` / `Nm Ns` string. */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/** Whether the given database type exposes the server dashboard (MySQL family). */
export function supportsServerDashboard(dbType: DatabaseType | undefined): boolean {
  return !!dbType && SERVER_DASHBOARD_DB_TYPES.has(dbType);
}

/** Prevent JDBC profiles that only borrow MySQL SQL syntax from exposing MySQL server administration queries. */
export function connectionSupportsServerDashboard(connection: ConnectionConfig | undefined): boolean {
  if (!connection || !supportsServerDashboard(effectiveDatabaseTypeForConnection(connection))) return false;
  if (connection.db_type !== "jdbc") return true;
  const profile = [connection.driver_profile, connection.connection_string, connection.jdbc_driver_class, ...(connection.jdbc_driver_paths ?? [])].filter(Boolean).join("\n");
  return !/(?:kyuubi|hive2|org\.apache\.hive\.jdbc\.HiveDriver|hive-jdbc)/i.test(profile);
}
