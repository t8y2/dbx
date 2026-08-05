import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { isSchemaAware, usesDatabaseObjectTreeMode, usesTreeSchemaMode } from "@/lib/database/databaseFeatureSupport";
import type { CodeMirrorSqlDialectName } from "@/lib/editor/codemirrorSqlDialect";

type JdbcDialectConnection = Pick<ConnectionConfig, "db_type"> & Partial<Pick<ConnectionConfig, "driver_profile" | "driver_label" | "connection_string" | "jdbc_driver_class" | "jdbc_driver_paths" | "database_info" | "external_config">>;

export type GaussdbIdentifierQuoteStyle = "auto" | "double" | "backtick";
export type GaussdbConnectionMode = "native" | "m-jdbc";

const GAUSSDB_IDENTIFIER_QUOTE_STYLE_KEY = "gaussdbIdentifierQuoteStyle";
export const GAUSSDB_M_JDBC_DRIVER_PROFILE = "gaussdb-m";
export const GAUSSDB_M_JDBC_DRIVER_CLASS = "com.huawei.gaussdb.jdbc.Driver";

const DATABASE_AS_EXECUTION_SCHEMA_TYPES = new Set<DatabaseType>(["hive", "spark"]);

const JDBC_DIALECT_MATCHERS: Array<{ type: DatabaseType; patterns: RegExp[] }> = [
  { type: "databend", patterns: [/jdbc:databend:/i, /com\.databend\.jdbc\.DatabendDriver/i, /databend-jdbc/i] },
  { type: "starrocks", patterns: [/starrocks/i] },
  { type: "doris", patterns: [/doris/i] },
  { type: "goldendb", patterns: [/jdbc:goldendb:/i, /goldendb/i] },
  { type: "mysql", patterns: [/kyuubi/i] },
  { type: "hive", patterns: [/inceptor/i, /\bapache\s+hive\b/i, /org\.apache\.hive\.jdbc\.HiveDriver/i, /hive-jdbc/i] },
  { type: "mysql", patterns: [/jdbc:mysql:/i, /mysql/i, /mariadb/i, /hive2/i] },
  { type: "gaussdb", patterns: [/jdbc:gaussdb:/i, /com\.huawei\.gaussdb/i, /gaussdb/i] },
  { type: "dameng", patterns: [/jdbc:dm:/i, /dm\.jdbc\.driver/i, /dameng/i] },
  { type: "opengauss", patterns: [/jdbc:opengauss:/i, /org\.opengauss/i, /opengauss/i] },
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

// ASE uses Transact-SQL, but treating it as SQL Server globally would also
// enable SQL Server metadata, pagination, and identifier rules. Keep this
// narrower matcher exclusively for editor syntax parsing.
const JDBC_ASE_PROFILE_PATTERNS = [/(?:^|[\s_-])ase(?:$|[\s_-])/i, /\bsap[\s_-]+ase\b/i, /\badaptive server enterprise\b/i];

export function inferJdbcDialect(connection?: JdbcDialectConnection): DatabaseType | undefined {
  if (!connection || connection.db_type !== "jdbc") return undefined;
  const haystack = [connection.driver_profile, connection.driver_label, connection.connection_string, connection.jdbc_driver_class, ...(connection.jdbc_driver_paths ?? []), connection.database_info?.productName, connection.database_info?.serverComment, connection.database_info?.driverName]
    .filter(Boolean)
    .join("\n");
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

export function connectionShouldLoadIdentifierQuote(connection: JdbcDialectConnection | undefined): boolean {
  if (!connection) return false;
  if (connection.db_type === "gbase" && isGbase8sProfile(connection.driver_profile)) return true;
  if (connection.db_type === "kingbase") return true;
  if (gaussdbIdentifierQuoteStyle(connection) !== "auto") return false;
  if (connection.db_type === "gaussdb") return true;
  if (connection.db_type !== "jdbc") return false;
  return ["gaussdb", "opengauss", "postgres"].includes(inferJdbcDialect(connection) ?? "");
}

export function supportsGaussdbIdentifierQuoteStyle(connection: JdbcDialectConnection | undefined): boolean {
  return effectiveDatabaseTypeForConnection(connection) === "gaussdb";
}

export function gaussdbIdentifierQuoteStyle(connection: JdbcDialectConnection | undefined): GaussdbIdentifierQuoteStyle {
  const external = externalConfigRecord(connection?.external_config);
  const style = external[GAUSSDB_IDENTIFIER_QUOTE_STYLE_KEY];
  return style === "double" || style === "backtick" ? style : "auto";
}

export function gaussdbIdentifierQuoteOverride(connection: JdbcDialectConnection | undefined): string | undefined {
  const style = gaussdbIdentifierQuoteStyle(connection);
  if (style === "double") return '"';
  if (style === "backtick") return "`";
  return undefined;
}

export function gaussdbConnectionMode(connection: JdbcDialectConnection | undefined): GaussdbConnectionMode {
  return connection?.db_type === "gaussdb" && connection.driver_profile?.toLowerCase() === GAUSSDB_M_JDBC_DRIVER_PROFILE ? "m-jdbc" : "native";
}

export function setGaussdbConnectionMode(connection: JdbcDialectConnection, mode: GaussdbConnectionMode) {
  if (connection.db_type !== "gaussdb") return;
  connection.driver_profile = mode === "m-jdbc" ? GAUSSDB_M_JDBC_DRIVER_PROFILE : "gaussdb";
  connection.driver_label = "GaussDB";
  connection.jdbc_driver_class = mode === "m-jdbc" ? GAUSSDB_M_JDBC_DRIVER_CLASS : undefined;
  connection.connection_string = undefined;
}

export function setGaussdbIdentifierQuoteStyle(
  connection: Pick<ConnectionConfig, "db_type"> & Partial<Pick<ConnectionConfig, "driver_profile" | "driver_label" | "connection_string" | "jdbc_driver_class" | "jdbc_driver_paths" | "database_info" | "external_config">>,
  style: GaussdbIdentifierQuoteStyle,
) {
  const external = externalConfigRecord(connection.external_config);
  if (style === "auto") {
    delete external[GAUSSDB_IDENTIFIER_QUOTE_STYLE_KEY];
  } else {
    external[GAUSSDB_IDENTIFIER_QUOTE_STYLE_KEY] = style;
  }
  connection.external_config = Object.keys(external).length > 0 ? external : undefined;
}

export function sqlSnippetDatabaseTypeForConnection(connection?: JdbcDialectConnection): DatabaseType | undefined {
  // ASE uses T-SQL snippets, but mapping it globally to SQL Server would also
  // enable incompatible SQL Server metadata and pagination behavior.
  if (isJdbcAseProfile(connection)) return "sqlserver";
  return effectiveDatabaseTypeForConnection(connection);
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

export function connectionShouldDiscoverJdbcSchemas(connection?: JdbcDialectConnection): boolean {
  // GBase 8s exposes owner schemas only when the current database can use them
  // in DML; non-ANSI databases fall back to the flat table tree.
  if (connection?.db_type === "gbase" && isGbase8sProfile(connection.driver_profile)) return true;
  return connection?.db_type === "jdbc" && !inferJdbcDialect(connection);
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
  if (effectiveDatabaseTypeForConnection(connection) === "informix") return schema || "";
  return schema || database;
}

export function metadataSchemaForConnection(connection: JdbcDialectConnection | undefined, database: string, schema?: string): string {
  const type = effectiveDatabaseTypeForConnection(connection);
  if (type === "sqlserver") return schema || "dbo";
  return connectionObjectTreeQuerySchema(connection, database, schema);
}

export function connectionObjectTreeNodeSchema(connection: JdbcDialectConnection | undefined, database: string, schema?: string): string | undefined {
  if (connection?.db_type === "jdbc" && inferJdbcDialect(connection) === "databend") return schema || database;
  if (connectionUsesDatabaseObjectTreeMode(connection)) return undefined;
  const type = effectiveDatabaseTypeForConnection(connection);
  if (type === "informix") return schema || undefined;
  if (type === "sqlite") return schema || database;
  if (!type) return schema;
  return isSchemaAware(type) ? schema || database : undefined;
}

/** Maps a database type to the corresponding CodeMirror SQL dialect name used by QueryEditor and DdlViewDialog. */
export function codeMirrorSqlDialect(dbType: DatabaseType | undefined): "mysql" | "postgres" | "sqlserver" {
  if (dbType === "postgres" || dbType === "gaussdb" || dbType === "kwdb" || dbType === "opengauss") return "postgres";
  if (dbType === "sqlserver") return "sqlserver";
  return "mysql";
}

export function codeMirrorSqlDialectForConnection(connection?: JdbcDialectConnection): CodeMirrorSqlDialectName {
  if (isJdbcAseProfile(connection)) return "sqlserver";
  const databaseType = effectiveDatabaseTypeForConnection(connection);
  if (databaseType === "clickhouse") return "clickhouse";
  return codeMirrorSqlDialect(databaseType);
}

function isJdbcAseProfile(connection?: JdbcDialectConnection): boolean {
  if (connection?.db_type !== "jdbc") return false;
  const explicitIdentity = [connection.driver_profile, connection.driver_label, connection.database_info?.productName].filter(Boolean).join("\n");
  return JDBC_ASE_PROFILE_PATTERNS.some((pattern) => pattern.test(explicitIdentity));
}

function isGbase8sProfile(driverProfile?: string): boolean {
  return driverProfile === "gbase8s";
}

function externalConfigRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}
