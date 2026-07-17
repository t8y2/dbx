import type { ConnectionConfig, DatabaseType, QueryResult } from "@/types/database";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { computeRate, formatBytes, formatBytesPerSec, formatNumber, formatRate, formatUptime, statusEntries, statusNumber, type StatusEntry, type StatusMap, type StatusSample } from "@/lib/database/serverMetrics";

/**
 * PostgreSQL server-monitoring helpers. Pure and framework-free so the rate math
 * and formatting can be unit-tested; the dashboard component owns the polling
 * loop and ring buffer, and feeds samples through these functions.
 *
 * The MySQL family lives in `./mysqlServerStatus`; the two engines' status
 * shapes differ (cumulative name/value pairs vs. a single aggregate row), so
 * the SQL/mapping/gates stay separate, but the sample/rate math and formatting
 * are identical and shared from `./serverMetrics` — re-exported here so
 * existing callers keep one import path.
 *
 * Data comes from one aggregate query over `pg_stat_database` / `pg_stat_activity`
 * / WAL position (`PG_STATUS_SQL`) and a one-shot settings query
 * (`PG_VARIABLES_SQL`), both run through the generic query bridge.
 */
export { computeRate, formatBytes, formatBytesPerSec, formatNumber, formatRate, formatUptime, statusEntries, statusNumber, type StatusEntry, type StatusMap, type StatusSample };

/**
 * Single round-trip aggregate, mirroring `SHOW GLOBAL STATUS` being one call.
 * Deliberately excludes `pg_stat_bgwriter`/checkpoint counters: those columns
 * moved to `pg_stat_checkpointer` in PG17, and a version-fragile query would
 * break the dashboard on newer servers for a nice-to-have metric.
 *
 * Scans `pg_stat_database` and `pg_stat_activity` exactly once each (one CTE
 * per view) rather than once per column — this runs every ~1-10s while the
 * dashboard is open, so re-scanning either view per column would be needless
 * repeated load on the server. Uses `SUM(CASE WHEN ...)` rather than the
 * `FILTER` clause for the conditional counts: `FILTER` is SQL:2003/PG9.4+,
 * and this dashboard is meant to work back to PG 9.2.
 *
 * The `pg_stat_activity` CTE excludes `pg_backend_pid()` — this query's own
 * backend is always `active` while it runs, so without the exclusion an
 * otherwise idle server would always show at least one active connection.
 * Rows whose `state` is NULL are excluded from the total because PostgreSQL
 * masks activity columns for sessions the current role cannot inspect.
 *
 * The WAL metric is recovery-aware: `pg_current_wal_lsn()` errors on a hot
 * standby ("recovery is in progress"), which would fail this entire combined
 * query on a read replica. `pg_is_in_recovery()` picks `pg_last_wal_replay_lsn()`
 * instead in that case — Postgres only evaluates the taken `CASE` branch, so
 * `pg_current_wal_lsn()` is never actually called while in recovery.
 */
export const PG_STATUS_SQL = `WITH db_stats AS (
  SELECT
    coalesce(sum(xact_commit),0) AS xact_commit,
    coalesce(sum(xact_rollback),0) AS xact_rollback,
    coalesce(sum(blks_hit),0) AS blks_hit,
    coalesce(sum(blks_read),0) AS blks_read,
    coalesce(sum(tup_returned),0) AS tup_returned,
    coalesce(sum(tup_fetched),0) AS tup_fetched,
    coalesce(sum(tup_inserted),0) AS tup_inserted,
    coalesce(sum(tup_updated),0) AS tup_updated,
    coalesce(sum(tup_deleted),0) AS tup_deleted,
    coalesce(sum(deadlocks),0) AS deadlocks,
    coalesce(sum(temp_files),0) AS temp_files
  FROM pg_stat_database
), activity_stats AS (
  SELECT
    coalesce(sum(CASE WHEN state IS NOT NULL THEN 1 ELSE 0 END),0) AS connections,
    coalesce(sum(CASE WHEN state = 'active' THEN 1 ELSE 0 END),0) AS active_connections,
    coalesce(sum(CASE WHEN state = 'idle' THEN 1 ELSE 0 END),0) AS idle_connections
  FROM pg_stat_activity
  WHERE pid <> pg_backend_pid()
)
SELECT
  db_stats.*,
  activity_stats.*,
  coalesce(CASE WHEN pg_is_in_recovery()
    THEN pg_wal_lsn_diff(pg_last_wal_replay_lsn(), '0/0')
    ELSE pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')
  END, 0) AS wal_bytes,
  floor(extract(epoch FROM (now() - pg_postmaster_start_time())))::bigint AS uptime_seconds
FROM db_stats, activity_stats`;

/**
 * Pre-10 fallback: PostgreSQL 10 renamed the WAL location functions
 * (`pg_current_xlog_location()` → `pg_current_wal_lsn()`,
 * `pg_last_xlog_replay_location()` → `pg_last_wal_replay_lsn()`,
 * `pg_xlog_location_diff()` → `pg_wal_lsn_diff()`). Every other column here
 * (pg_stat_database's transaction, block, tuple, deadlock and temp-file
 * counters, pg_stat_activity, pg_is_in_recovery(), pg_postmaster_start_time())
 * has been present since 9.2, so this is the only piece that needs a
 * version-gated fallback.
 */
export const PG_STATUS_LEGACY_SQL = PG_STATUS_SQL.replace(/\bpg_current_wal_lsn\b/g, "pg_current_xlog_location")
  .replace(/\bpg_last_wal_replay_lsn\b/g, "pg_last_xlog_replay_location")
  .replace(/\bpg_wal_lsn_diff\b/g, "pg_xlog_location_diff");

export const PG_VARIABLES_SQL = "SELECT current_setting('max_connections') AS max_connections, current_setting('server_version') AS version";

/** Max samples retained for the live charts (~ a few minutes at 5s cadence). */
export const MAX_SAMPLES = 60;

/** Engines exposing `pg_stat_database`/`pg_stat_activity` in the shape this dashboard expects. */
const SERVER_DASHBOARD_DB_TYPES = new Set<DatabaseType>(["postgres"]);

/** Detect the undefined-function failure produced by pre-10 servers lacking `pg_current_wal_lsn`/`pg_last_wal_replay_lsn`/`pg_wal_lsn_diff`. */
export function isPgStatusCompatibilityError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  // SQLSTATE 42883 (undefined_function) is not specific to the WAL functions —
  // any missing function in PG_STATUS_SQL would raise it. Only treat this as
  // the pre-PG10 WAL rename by also requiring the message to name one of the
  // three renamed functions; otherwise it's a different, unrelated failure and
  // retrying with the legacy WAL query wouldn't fix it.
  if (code !== "" && code !== "42883") return false;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:pg_current_wal_lsn|pg_last_wal_replay_lsn|pg_wal_lsn_diff)/i.test(message) && /does not exist/i.test(message);
}

/** Parse the single-row `PG_STATUS_SQL` / `PG_VARIABLES_SQL` result into a name/value map. */
export function parsePgStatusRow(result: QueryResult | null | undefined): StatusMap {
  const map: StatusMap = {};
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows) || result.rows.length === 0) return map;
  const row = result.rows[0];
  result.columns.forEach((column, idx) => {
    const value = row[idx];
    map[column] = value === null || value === undefined ? "" : String(value);
  });
  return map;
}

/** Transactions/sec between two samples: rate of committed + rolled-back transactions. */
export function computePgTps(prev: StatusSample, curr: StatusSample): number {
  return computeRate(prev, curr, "xact_commit") + computeRate(prev, curr, "xact_rollback");
}

/**
 * Shared-buffer cache hit ratio (0-100) from cumulative block hits vs reads.
 * Returns null when no data has been accumulated yet.
 */
export function pgCacheHitRatio(status: StatusMap): number | null {
  const hits = statusNumber(status, "blks_hit");
  const reads = statusNumber(status, "blks_read");
  const total = hits + reads;
  if (total <= 0) return null;
  const ratio = (hits / total) * 100;
  if (!Number.isFinite(ratio)) return null;
  return Math.max(0, Math.min(100, ratio));
}

/** Whether the given database type exposes the Postgres server dashboard. */
export function supportsServerDashboard(dbType: DatabaseType | undefined): boolean {
  return !!dbType && SERVER_DASHBOARD_DB_TYPES.has(dbType);
}

/** Connection-aware gate (mirrors the MySQL server-dashboard gate). */
export function connectionSupportsServerDashboard(connection: ConnectionConfig | undefined): boolean {
  return !!connection && supportsServerDashboard(effectiveDatabaseTypeForConnection(connection));
}
