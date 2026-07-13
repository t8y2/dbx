import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { isSchemaAware, usesDatabaseObjectTreeMode, usesTreeSchemaMode } from "@/lib/database/databaseFeatureSupport";

type JdbcDialectConnection = Pick<ConnectionConfig, "db_type"> & Partial<Pick<ConnectionConfig, "driver_profile" | "connection_string" | "jdbc_driver_class" | "jdbc_driver_paths">>;

const DATABASE_AS_EXECUTION_SCHEMA_TYPES = new Set<DatabaseType>(["hive", "spark"]);

const JDBC_DIALECT_MATCHERS: Array<{ type: DatabaseType; patterns: RegExp[] }> = [
  { type: "databend", patterns: [/jdbc:databend:/i, /com\.databend\.jdbc\.DatabendDriver/i, /databend-jdbc/i] },
  { type: "starrocks", patterns: [/starrocks/i] },
  { type: "doris", patterns: [/doris/i] },
  { type: "goldendb", patterns: [/jdbc:goldendb:/i, /goldendb/i] },
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
  { type: "iris", patterns: [/jdbc:(?:iris|cache):/i, /com\.intersystems\.jdbc\.(?:IRIS|Cache)Driver/i, /intersystems-jdbc/i] },
];

export function inferJdbcDialect(connection?: JdbcDialectConnection): DatabaseType | undefined {
  if (!connection || connection.db_type !== "jdbc") return undefined;
  const haystack = [connection.driver_profile, connection.connection_string, connection.jdbc_driver_class, ...(connection.jdbc_driver_paths ?? [])].filter(Boolean).join("\n");
  if (!haystack) return undefined;
  return JDBC_DIALECT_MATCHERS.find((matcher) => matcher.patterns.some((pattern) => pattern.test(haystack)))?.type;
}

export function effectiveDatabaseTypeForConnection(connection?: JdbcDialectConnection): DatabaseType | undefined {
  if (!connection) return undefined;
  if (connection.db_type === "gbase" && isGbase8sProfile(connection.driver_profile)) return "informix";
  if (connection.db_type === "gbase") return "mysql";
  // MySQL-protocol connections to Doris/StarRocks (db_type=mysql with a
  // starrocks/doris driver_profile) must use the Doris/StarRocks SQL dialect so
  // that multi-catalog 3-part names (`catalog.database.table`) are emitted.
  // mysql and starrocks share the backtick-quoting + LIMIT dialect, so this
  // only widens the catalog-aware SQL generation path without other side effects.
  if (connection.db_type === "mysql") {
    const profile = connection.driver_profile?.toLowerCase();
    if (profile === "starrocks") return "starrocks";
    if (profile === "doris" || profile === "selectdb") return "doris";
  }
  if (connection.db_type !== "jdbc") return connection.db_type;
  return inferJdbcDialect(connection) ?? "jdbc";
}

export function tableStructureDatabaseTypeForConnection(connection?: JdbcDialectConnection): DatabaseType | undefined {
  if (!connection) return undefined;
  if (connection.db_type === "gbase" && !isGbase8sProfile(connection.driver_profile)) return "gbase";
  return effectiveDatabaseTypeForConnection(connection);
}

export function connectionUsesDatabaseObjectTreeMode(connection?: JdbcDialectConnection): boolean {
  if (!connection) return false;
  if (connection.db_type !== "jdbc") return usesDatabaseObjectTreeMode(effectiveDatabaseTypeForConnection(connection));
  const dialect = inferJdbcDialect(connection);
  if (!dialect) return true;
  if (dialect === "hive" || dialect === "trino") return false;
  if (dialect === "databend") return true;
  return !usesTreeSchemaMode(dialect);
}

export function connectionUsesSchemaExecutionContext(connection?: Pick<ConnectionConfig, "db_type" | "connection_string" | "jdbc_driver_class" | "jdbc_driver_paths">): boolean {
  return connection?.db_type === "jdbc" && inferJdbcDialect(connection) === "databend";
}

export function connectionQueryExecutionSchema(connection: JdbcDialectConnection | undefined, database: string | undefined, schema: string | undefined, dataMode: boolean): string | undefined {
  if (connectionUsesSchemaExecutionContext(connection)) return schema || database || undefined;
  if (dataMode || connectionUsesDatabaseObjectTreeMode(connection)) return undefined;
  if (schema) return schema;
  const type = effectiveDatabaseTypeForConnection(connection);
  // Hive and Spark display their SQL namespace in the database selector, but
  // their agents switch it with USE through the schema execution parameter.
  return type && DATABASE_AS_EXECUTION_SCHEMA_TYPES.has(type) ? database || undefined : undefined;
}

export function connectionObjectTreeQuerySchema(connection: JdbcDialectConnection | undefined, database: string, schema?: string): string {
  if (connection?.db_type === "jdbc" && inferJdbcDialect(connection) === "databend") return schema || database;
  if (connectionUsesDatabaseObjectTreeMode(connection)) return "";
  return schema || database;
}

export function metadataSchemaForConnection(connection: JdbcDialectConnection | undefined, database: string, schema?: string): string {
  const type = effectiveDatabaseTypeForConnection(connection);
  if (type === "sqlserver") return schema || "dbo";
  return connectionObjectTreeQuerySchema(connection, database, schema);
}

export function connectionObjectTreeNodeSchema(connection: JdbcDialectConnection | undefined, database: string, schema?: string): string | undefined {
  if (connection?.db_type === "jdbc" && inferJdbcDialect(connection) === "databend") return schema || database;
  if (connection?.db_type === "jdbc" && inferJdbcDialect(connection) === "databend") return schema || database;
  if (connectionUsesDatabaseObjectTreeMode(connection)) return undefined;
  if (schema) return schema;
  const type = effectiveDatabaseTypeForConnection(connection);
  return isSchemaAware(type) ? database : undefined;
}

/** Maps a database type to the corresponding CodeMirror SQL dialect name used by QueryEditor and DdlViewDialog. */
export function codeMirrorSqlDialect(dbType: DatabaseType | undefined): "mysql" | "postgres" | "sqlserver" {
  if (dbType === "postgres" || dbType === "gaussdb" || dbType === "kwdb" || dbType === "opengauss") return "postgres";
  if (dbType === "sqlserver") return "sqlserver";
  return "mysql";
}

function isGbase8sProfile(driverProfile?: string): boolean {
  return driverProfile === "gbase8s";
}
