import type { ConnectionConfig, DatabaseType, QueryResult } from "@/types/database";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { buildXuguKillTransactionSql, mapXuguTransactionRows, XUGU_OWN_SESSION_SQL, XUGU_TRANSACTION_LIST_SQL, xuguTransactionKey } from "./xuguProcessList";
import { buildCancelQuerySql as buildMysqlCancelQuerySql, buildTerminateSessionSql as buildMysqlTerminateSessionSql, mapProcessRows as mapMysqlProcessRows, PROCESS_LIST_SQL as MYSQL_PROCESS_LIST_SQL, supportsProcessList as supportsMysqlProcessList } from "./mysqlProcessList";
import {
  buildKingbaseCancelQuerySql,
  buildKingbasePgCancelQuerySql,
  buildKingbasePgTerminateSessionSql,
  buildKingbaseTerminateSessionSql,
  buildPgCancelQuerySql,
  buildPgTerminateSessionSql,
  isKingbaseOwnSessionCatalogCompatibilityError,
  isKingbaseProcessListCatalogCompatibilityError,
  isKingbaseCancelCatalogCompatibilityError,
  isKingbaseTerminateCatalogCompatibilityError,
  isPgProcessListCompatibilityError,
  kingbaseCancelQueryResultError,
  kingbasePgCancelQueryResultError,
  kingbasePgTerminateSessionResultError,
  kingbaseTerminateSessionResultError,
  KINGBASE_OWN_SESSION_SQL,
  KINGBASE_PG_OWN_SESSION_SQL,
  KINGBASE_PG_PROCESS_LIST_SQL,
  KINGBASE_PROCESS_LIST_SQL,
  mapPgProcessRows,
  OPENGAUSS_OWN_SESSION_SQL,
  OPENGAUSS_PROCESS_LIST_SQL,
  pgCancelQueryResultError,
  pgTerminateSessionResultError,
  PG_OWN_SESSION_SQL,
  PG_PROCESS_LIST_LEGACY_SQL,
  PG_PROCESS_LIST_SQL,
} from "./postgresProcessList";

/**
 * Engine-agnostic operations model. Each supported engine contributes a driver
 * describing how to list sessions or transactions, identify the caller's own
 * session, render columns, and perform its explicitly named action.
 */

/** A displayable row. `id` is the session/process id; transaction drivers use a separate composite target. */
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
  /** Xugu displays active transactions rather than a full session list. */
  mode?: "transaction";
  /** Execution database for a system-wide administrative view. */
  database?: string;
  /** Stable row key when a server-local session id is not globally unique. */
  rowKey?(row: ProcessRow): string;
  /** Whether the panel offers multi-selection and batch query cancellation. */
  supportsBatchCancel?: boolean;
  /** SQL that lists sessions or, for transaction mode, active transactions. */
  listSql: string;
  /** Compatibility query used when the primary list SQL references newer columns. */
  fallbackListSql?: string;
  /** Restrict fallback attempts to known version-compatibility failures. */
  shouldUseFallbackListSql?(error: unknown): boolean;
  /** Scalar SQL returning the caller's own session id (nullable path tolerated). */
  ownSessionSql: string;
  /** Compatibility query used when the primary own-session function is unavailable. */
  fallbackOwnSessionSql?: string;
  /** Restrict own-session fallback attempts to known compatibility failures. */
  shouldUseFallbackOwnSessionSql?(error: unknown): boolean;
  /** Columns to render, in display order. */
  columns: ProcessColumn[];
  /** Column key used for the initial sort. */
  defaultSortKey: string;
  /** Upper bound on rows fetched per refresh. */
  maxRows: number;
  /** Map a raw list result into typed rows. */
  mapRows(result: QueryResult | null | undefined): ProcessRow[];
  /** Build the validated statement that cancels the selected session's running query. */
  buildCancelQuerySql?(id: number): string;
  /** Xugu-only action: end the selected transaction without disconnecting its session. */
  buildKillTransactionSql?(row: ProcessRow): string;
  /** Build the compatibility statement used when the primary cancellation function is unavailable. */
  buildFallbackCancelQuerySql?(id: number): string;
  /** Restrict cancellation fallback attempts to known compatibility failures. */
  shouldUseFallbackCancelQuerySql?(error: unknown): boolean;
  /** Validate any engine-specific success value returned by the cancellation statement. */
  cancelQueryResultError?(results: QueryResult[]): string | null;
  /** Validate the success value returned by the compatibility cancellation statement. */
  fallbackCancelQueryResultError?(results: QueryResult[]): string | null;
  /**
   * Build the validated statement that disconnects the session. Engines that omit it
   * only offer query cancellation, because they cannot close a session over the wire.
   */
  buildTerminateSessionSql?(id: number): string;
  /** Build the compatibility statement used when the primary terminate function is unavailable. */
  buildFallbackTerminateSessionSql?(id: number): string;
  /** Restrict terminate fallback attempts to known compatibility failures. */
  shouldUseFallbackTerminateSessionSql?(error: unknown): boolean;
  /** Validate any engine-specific success value returned by the terminate statement. */
  terminateSessionResultError?(results: QueryResult[]): string | null;
  /** Validate the success value returned by the compatibility terminate statement. */
  fallbackTerminateSessionResultError?(results: QueryResult[]): string | null;
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
  supportsBatchCancel: true,
  listSql: MYSQL_PROCESS_LIST_SQL,
  ownSessionSql: "SELECT CONNECTION_ID()",
  columns: MYSQL_COLUMNS,
  defaultSortKey: "time",
  maxRows: 5000,
  // Typed structs carry no index signature; they are plain string-keyed objects at runtime.
  mapRows: (result) => mapMysqlProcessRows(result) as unknown as ProcessRow[],
  buildCancelQuerySql: buildMysqlCancelQuerySql,
  buildTerminateSessionSql: buildMysqlTerminateSessionSql,
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
  buildCancelQuerySql: buildPgCancelQuerySql,
  cancelQueryResultError: pgCancelQueryResultError,
  buildTerminateSessionSql: buildPgTerminateSessionSql,
  terminateSessionResultError: pgTerminateSessionResultError,
};

const OPENGAUSS_DRIVER: ProcessListDriver = {
  listSql: OPENGAUSS_PROCESS_LIST_SQL,
  ownSessionSql: OPENGAUSS_OWN_SESSION_SQL,
  columns: POSTGRES_COLUMNS,
  defaultSortKey: "time",
  maxRows: 5000,
  mapRows: (result) => mapPgProcessRows(result) as unknown as ProcessRow[],
  buildCancelQuerySql: buildPgCancelQuerySql,
  cancelQueryResultError: pgCancelQueryResultError,
  buildTerminateSessionSql: buildPgTerminateSessionSql,
  terminateSessionResultError: pgTerminateSessionResultError,
};

const KINGBASE_DRIVER: ProcessListDriver = {
  listSql: KINGBASE_PROCESS_LIST_SQL,
  fallbackListSql: KINGBASE_PG_PROCESS_LIST_SQL,
  shouldUseFallbackListSql: isKingbaseProcessListCatalogCompatibilityError,
  ownSessionSql: KINGBASE_OWN_SESSION_SQL,
  fallbackOwnSessionSql: KINGBASE_PG_OWN_SESSION_SQL,
  shouldUseFallbackOwnSessionSql: isKingbaseOwnSessionCatalogCompatibilityError,
  columns: POSTGRES_COLUMNS,
  defaultSortKey: "time",
  maxRows: 5000,
  mapRows: (result) => mapPgProcessRows(result) as unknown as ProcessRow[],
  buildCancelQuerySql: buildKingbaseCancelQuerySql,
  buildFallbackCancelQuerySql: buildKingbasePgCancelQuerySql,
  shouldUseFallbackCancelQuerySql: isKingbaseCancelCatalogCompatibilityError,
  cancelQueryResultError: kingbaseCancelQueryResultError,
  fallbackCancelQueryResultError: kingbasePgCancelQueryResultError,
  buildTerminateSessionSql: buildKingbaseTerminateSessionSql,
  buildFallbackTerminateSessionSql: buildKingbasePgTerminateSessionSql,
  shouldUseFallbackTerminateSessionSql: isKingbaseTerminateCatalogCompatibilityError,
  terminateSessionResultError: kingbaseTerminateSessionResultError,
  fallbackTerminateSessionResultError: kingbasePgTerminateSessionResultError,
};

const XUGU_COLUMNS: ProcessColumn[] = [
  { key: "nodeId", labelKey: "processList.transactionNode", mono: true, numeric: true },
  { key: "transactionId", labelKey: "processList.transactionId", mono: true },
  { key: "id", labelKey: "processList.transactionSession", mono: true, numeric: true },
  { key: "user", labelKey: "processList.colUser" },
  { key: "db", labelKey: "processList.colDb" },
  { key: "host", labelKey: "processList.colClient" },
  { key: "startTime", labelKey: "processList.transactionStart" },
];

const XUGU_DRIVER: ProcessListDriver = {
  mode: "transaction",
  database: "SYSTEM",
  listSql: XUGU_TRANSACTION_LIST_SQL,
  ownSessionSql: XUGU_OWN_SESSION_SQL,
  columns: XUGU_COLUMNS,
  defaultSortKey: "startTime",
  maxRows: 5000,
  mapRows: (result) => mapXuguTransactionRows(result) as unknown as ProcessRow[],
  rowKey: (row) => xuguTransactionKey(row as unknown as ReturnType<typeof mapXuguTransactionRows>[number]),
  buildKillTransactionSql: (row) => buildXuguKillTransactionSql(row as unknown as ReturnType<typeof mapXuguTransactionRows>[number]),
};

/** Resolve the process-list driver for a connection, or null if unsupported. */
export function resolveProcessListDriver(dbType: DatabaseType | undefined): ProcessListDriver | null {
  if (supportsMysqlProcessList(dbType)) return MYSQL_DRIVER;
  if (dbType === "postgres") return POSTGRES_DRIVER;
  if (dbType === "opengauss") return OPENGAUSS_DRIVER;
  if (dbType === "kingbase") return KINGBASE_DRIVER;
  if (dbType === "xugu") return XUGU_DRIVER;
  return null;
}

/** Whether the shared operations panel covers this engine. */
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
  const dbType = effectiveDatabaseTypeForConnection(connection);
  if (dbType === "gaussdb" && connection.driver_profile?.toLowerCase() === "opengauss") return OPENGAUSS_DRIVER;
  // Xugu's SYS_* transaction views and DBMS_DBA.KILL_TRANS are queried through
  // SYSTEM. A DBA grant in a business database does not make that login SYSDBA.
  if (dbType === "xugu" && connection.username?.trim().toUpperCase() !== "SYSDBA") return null;
  return resolveProcessListDriver(dbType);
}

/** Connection-aware process-list gate (mirrors the server-dashboard gate). */
export function connectionSupportsProcessList(connection: ConnectionConfig | undefined): boolean {
  return resolveProcessListDriverForConnection(connection) !== null;
}
