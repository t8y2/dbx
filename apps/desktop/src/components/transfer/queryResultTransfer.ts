import { supportsTransfer } from "@/lib/database/databaseFeatureSupport";
import { parseBinaryCellBytes } from "@/lib/dataGrid/binaryCellDownload";
import { effectiveDatabaseTypeForConnection, transferDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import type { ConnectionConfig, DatabaseType, QueryResult } from "@/types/database";
export { alwaysIdentityColumnNamesFromDdl, identityColumnNamesFromDdl, nonInsertableColumnNamesFromDdl, rewriteCreateTableName, transactionalMysqlTableDdl } from "./queryResultTransferDdl";

// MongoDB's transfer capability uses document writes, not SQL transactions.
export function queryResultTransferDatabaseType(connection?: Pick<ConnectionConfig, "db_type" | "driver_profile" | "driver_label" | "connection_string" | "url_params" | "jdbc_driver_class" | "jdbc_driver_paths" | "database_info" | "external_config" | "username">): DatabaseType | undefined {
  const effective = effectiveDatabaseTypeForConnection(connection);
  if (effective === "doris" || effective === "starrocks") return undefined;
  const type = transferDatabaseTypeForConnection(connection);
  return type && supportsQueryResultTransferDatabaseType(type) ? type : undefined;
}

// An agent runtime alone does not imply transactions (for example Hive/Spark
// reject them and ArgoDB auto-commits). Keep this list tied to implemented
// transaction paths, not the broader table-transfer feature flag.
const TRANSACTIONAL_TRANSFER_TYPES = new Set<DatabaseType>(["mysql", "postgres", "sqlite", "sqlserver", "oracle", "oceanbase-oracle", "dameng", "yashandb", "kingbase", "highgo", "vastbase", "h2", "db2", "iris", "goldendb"]);

/** executeInTransaction has a SQL batch transaction path for these engines. */
export function supportsQueryResultTransferDatabaseType(type?: DatabaseType): boolean {
  return !!type && supportsTransfer(type) && TRANSACTIONAL_TRANSFER_TYPES.has(type);
}

export function supportsQueryResultTransfer(connection?: Parameters<typeof queryResultTransferDatabaseType>[0]): boolean {
  return queryResultTransferDatabaseType(connection) !== undefined;
}

export function queryResultTransferIncomplete(result: QueryResult, rowLimit?: number): boolean {
  return result.truncated === true || result.has_more === true || (rowLimit !== undefined && result.rows.length > rowLimit);
}

export function normalizeQueryResultColumnType(sourceType: string, databaseType: DatabaseType): string {
  const type = sourceType.trim();
  if (databaseType === "mysql" && /^varchar$/i.test(type)) return "VARCHAR(255)";
  if (databaseType === "mysql" && /^varbinary$/i.test(type)) return "VARBINARY(255)";
  if (databaseType === "mysql" && /^(enum|set)$/i.test(type)) return "TEXT";
  return type;
}

/** Return the original bytes represented by a query-result binary value. */
export function binaryQueryResultValueHex(value: unknown): string {
  const parsed = parseBinaryCellBytes(value, "binary");
  if (parsed) return Array.from(parsed, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (typeof value === "string") {
    return Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return Array.from(new TextEncoder().encode(typeof value === "object" ? JSON.stringify(value) : String(value)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Build the idempotent cleanup statement for a transfer staging table. */
export function queryResultTransferStagingCleanupSql(table: string): string {
  return `DROP TABLE IF EXISTS ${table}`;
}

const ORACLE_STYLE_CLEANUP_TYPES = new Set<DatabaseType>(["oracle", "oceanbase-oracle", "dameng", "yashandb"]);
const NON_TRANSACTIONAL_DDL_TYPES = new Set<DatabaseType>([...ORACLE_STYLE_CLEANUP_TYPES, "mysql", "goldendb", "h2"]);

export function queryResultTransferNeedsCreateCleanup(databaseType: DatabaseType): boolean {
  return NON_TRANSACTIONAL_DDL_TYPES.has(databaseType);
}

/** Remove a newly created target after an agent-backed non-transactional DDL failure. */
export function queryResultTransferCreateCleanupSql(table: string, databaseType: DatabaseType): string {
  if (!ORACLE_STYLE_CLEANUP_TYPES.has(databaseType)) return queryResultTransferStagingCleanupSql(table);
  const escapedTable = table.replaceAll("'", "''");
  return `BEGIN EXECUTE IMMEDIATE 'DROP TABLE ${escapedTable} CASCADE CONSTRAINTS'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;`;
}
