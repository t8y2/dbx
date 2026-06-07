import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { isSchemaAware, usesDatabaseObjectTreeMode } from "@/lib/databaseFeatureSupport";

const JDBC_DIALECT_MATCHERS: Array<{ type: DatabaseType; patterns: RegExp[] }> = [
  { type: "starrocks", patterns: [/starrocks/i] },
  { type: "doris", patterns: [/doris/i] },
  { type: "hive", patterns: [/org\.apache\.hive\.jdbc\.HiveDriver/i, /hive-jdbc/i] },
  { type: "mysql", patterns: [/jdbc:mysql:/i, /mysql/i, /mariadb/i, /kyuubi/i, /hive2/i] },
  { type: "postgres", patterns: [/jdbc:postgresql:/i, /postgres/i] },
  { type: "sqlserver", patterns: [/jdbc:sqlserver:/i, /sqlserver/i, /mssql/i] },
  { type: "oracle", patterns: [/jdbc:oracle:/i, /oracle/i] },
  { type: "clickhouse", patterns: [/jdbc:clickhouse:/i, /clickhouse/i] },
  { type: "h2", patterns: [/jdbc:h2:/i, /\bh2\b/i] },
  { type: "sqlite", patterns: [/jdbc:sqlite:/i, /sqlite/i] },
  { type: "db2", patterns: [/jdbc:db2:/i, /\bdb2\b/i] },
  { type: "informix", patterns: [/jdbc:informix/i, /informix/i] },
];

export function inferJdbcDialect(
  connection?: Pick<ConnectionConfig, "db_type" | "connection_string" | "jdbc_driver_class" | "jdbc_driver_paths">,
): DatabaseType | undefined {
  if (!connection || connection.db_type !== "jdbc") return undefined;
  const haystack = [connection.connection_string, connection.jdbc_driver_class, ...(connection.jdbc_driver_paths ?? [])]
    .filter(Boolean)
    .join("\n");
  if (!haystack) return undefined;
  return JDBC_DIALECT_MATCHERS.find((matcher) => matcher.patterns.some((pattern) => pattern.test(haystack)))?.type;
}

export function effectiveDatabaseTypeForConnection(
  connection?: Pick<ConnectionConfig, "db_type" | "connection_string" | "jdbc_driver_class" | "jdbc_driver_paths">,
): DatabaseType | undefined {
  if (!connection) return undefined;
  if (connection.db_type !== "jdbc") return connection.db_type;
  return inferJdbcDialect(connection) ?? "jdbc";
}

export function connectionUsesDatabaseObjectTreeMode(
  connection?: Pick<ConnectionConfig, "db_type" | "connection_string" | "jdbc_driver_class" | "jdbc_driver_paths">,
): boolean {
  if (!connection) return false;
  if (connection.db_type !== "jdbc") return usesDatabaseObjectTreeMode(connection.db_type);
  const dialect = inferJdbcDialect(connection);
  if (dialect === "hive" || dialect === "trino") return false;
  return true;
}

export function connectionObjectTreeQuerySchema(
  connection:
    | Pick<ConnectionConfig, "db_type" | "connection_string" | "jdbc_driver_class" | "jdbc_driver_paths">
    | undefined,
  database: string,
  schema?: string,
): string {
  if (connectionUsesDatabaseObjectTreeMode(connection)) return "";
  return schema || database;
}

export function connectionObjectTreeNodeSchema(
  connection:
    | Pick<ConnectionConfig, "db_type" | "connection_string" | "jdbc_driver_class" | "jdbc_driver_paths">
    | undefined,
  database: string,
  schema?: string,
): string | undefined {
  if (connectionUsesDatabaseObjectTreeMode(connection)) return undefined;
  if (schema) return schema;
  const type = connection?.db_type === "jdbc" ? effectiveDatabaseTypeForConnection(connection) : connection?.db_type;
  return isSchemaAware(type) ? database : undefined;
}
