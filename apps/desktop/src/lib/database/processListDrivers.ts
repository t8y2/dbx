import type { ConnectionConfig, DatabaseType, QueryResult } from "@/types/database";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { buildKillSql as buildMysqlKillSql, mapProcessRows as mapMysqlProcessRows, PROCESS_LIST_SQL as MYSQL_PROCESS_LIST_SQL, supportsProcessList as supportsMysqlProcessList } from "./mysqlProcessList";
import { buildPgKillSql, isPgProcessListCompatibilityError, mapPgProcessRows, pgKillResultError, PG_OWN_SESSION_SQL, PG_PROCESS_LIST_LEGACY_SQL, PG_PROCESS_LIST_SQL, supportsPgProcessList } from "./postgresProcessList";

/**
 * Engine-agnostic process-list model. Each supported engine contributes a driver
 * describing how to list sessions, identify the caller's own session, render the
 * columns, and kill a session. The panel component stays entirely generic.
 */

/** A displayable session row. `id` is the value passed to the driver's kill SQL. */
export type ProcessRow = { id: number } & Record<string, string | number | null>;

export interface ProcessColumn {
  /** Key into the mapped row. */
  key: string;
  /** i18n key for the header label. */
  labelKey: string;
  /** Render the cell in a monospace font. */
  mono?: boolean;
  /** Sort numerically and default to descending on first click. */
  numeric?: boolean;
  /** Long free text (SQL statement) — truncate with a hover title. */
  wide?: boolean;
}

export interface ProcessListDriver {
  /** SQL that lists current sessions, one row each. */
  listSql: string;
  /** Compatibility query used when the primary list SQL references newer columns. */
  fallbackListSql?: string;
  /** Restrict fallback attempts to known version-compatibility failures. */
  shouldUseFallbackListSql?(error: unknown): boolean;
  /** Scalar SQL returning the caller's own session id (nullable path tolerated). */
  ownSessionSql: string;
  /** Columns to render, in display order. */
  columns: ProcessColumn[];
  /** Column key used for the initial sort. */
  defaultSortKey: string;
  /** Upper bound on rows fetched per refresh. */
  maxRows: number;
  /** Map a raw list result into typed rows. */
  mapRows(result: QueryResult | null | undefined): ProcessRow[];
  /** Build the validated statement that kills the given session id. */
  buildKillSql(id: number): string;
  /** Validate any engine-specific success value returned by the kill statement. */
  killResultError?(results: QueryResult[]): string | null;
}

const MYSQL_COLUMNS: ProcessColumn[] = [
  { key: "id", labelKey: "processList.colId", mono: true, numeric: true },
  { key: "user", labelKey: "processList.colUser" },
  { key: "host", labelKey: "processList.colHost" },
  { key: "db", labelKey: "processList.colDb" },
  { key: "command", labelKey: "processList.colCommand" },
  { key: "time", labelKey: "processList.colTime", mono: true, numeric: true },
  { key: "state", labelKey: "processList.colState" },
  { key: "info", labelKey: "processList.colInfo", mono: true, wide: true },
];

const POSTGRES_COLUMNS: ProcessColumn[] = [
  { key: "id", labelKey: "processList.colPid", mono: true, numeric: true },
  { key: "user", labelKey: "processList.colUser" },
  { key: "db", labelKey: "processList.colDb" },
  { key: "client", labelKey: "processList.colClient" },
  { key: "app", labelKey: "processList.colApp" },
  { key: "state", labelKey: "processList.colState" },
  { key: "wait", labelKey: "processList.colWait" },
  { key: "time", labelKey: "processList.colTime", mono: true, numeric: true },
  { key: "query", labelKey: "processList.colQuery", mono: true, wide: true },
];

const MYSQL_DRIVER: ProcessListDriver = {
  listSql: MYSQL_PROCESS_LIST_SQL,
  ownSessionSql: "SELECT CONNECTION_ID()",
  columns: MYSQL_COLUMNS,
  defaultSortKey: "time",
  maxRows: 5000,
  // Typed structs carry no index signature; they are plain string-keyed objects at runtime.
  mapRows: (result) => mapMysqlProcessRows(result) as unknown as ProcessRow[],
  buildKillSql: buildMysqlKillSql,
};

const POSTGRES_DRIVER: ProcessListDriver = {
  listSql: PG_PROCESS_LIST_SQL,
  fallbackListSql: PG_PROCESS_LIST_LEGACY_SQL,
  shouldUseFallbackListSql: isPgProcessListCompatibilityError,
  ownSessionSql: PG_OWN_SESSION_SQL,
  columns: POSTGRES_COLUMNS,
  defaultSortKey: "time",
  maxRows: 5000,
  mapRows: (result) => mapPgProcessRows(result) as unknown as ProcessRow[],
  buildKillSql: buildPgKillSql,
  killResultError: pgKillResultError,
};

/** Resolve the process-list driver for a connection, or null if unsupported. */
export function resolveProcessListDriver(dbType: DatabaseType | undefined): ProcessListDriver | null {
  if (supportsMysqlProcessList(dbType)) return MYSQL_DRIVER;
  if (supportsPgProcessList(dbType)) return POSTGRES_DRIVER;
  return null;
}

/** Whether any process-list viewer (MySQL or Postgres family) covers this engine. */
export function supportsProcessList(dbType: DatabaseType | undefined): boolean {
  return resolveProcessListDriver(dbType) !== null;
}

/**
 * JDBC profiles that only borrow MySQL SQL syntax (Kyuubi / HiveServer2) infer as
 * `mysql` but are Spark/Hive engines that cannot serve `SHOW FULL PROCESSLIST`.
 */
const MYSQL_LOOKALIKE_JDBC = /(?:kyuubi|hive2|org\.apache\.hive\.jdbc\.HiveDriver|hive-jdbc)/i;

/**
 * Resolve the process-list driver from the real connection profile. Uses the
 * effective engine (so JDBC connections that resolve to MySQL/Postgres work) and
 * excludes MySQL-lookalike JDBC engines that cannot serve the process list.
 */
export function resolveProcessListDriverForConnection(connection: ConnectionConfig | undefined): ProcessListDriver | null {
  if (!connection) return null;
  if (connection.db_type === "jdbc") {
    const profile = [connection.driver_profile, connection.connection_string, connection.jdbc_driver_class, ...(connection.jdbc_driver_paths ?? [])].filter(Boolean).join("\n");
    if (MYSQL_LOOKALIKE_JDBC.test(profile)) return null;
  }
  return resolveProcessListDriver(effectiveDatabaseTypeForConnection(connection));
}

/** Connection-aware process-list gate (mirrors the server-dashboard gate). */
export function connectionSupportsProcessList(connection: ConnectionConfig | undefined): boolean {
  return resolveProcessListDriverForConnection(connection) !== null;
}
