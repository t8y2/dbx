import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { isSchemaAware, spannerObjectTreeSchema, usesDatabaseObjectTreeMode, usesTreeSchemaMode } from "@/lib/database/databaseFeatureSupport";
import type { CodeMirrorSqlDialectName } from "@/lib/editor/codemirrorSqlDialect";

type JdbcDialectConnection = Partial<Pick<ConnectionConfig, "db_type" | "driver_profile" | "driver_label" | "connection_string" | "url_params" | "jdbc_driver_class" | "jdbc_driver_paths" | "database_info" | "external_config">>;

export type GaussdbIdentifierQuoteStyle = "auto" | "double" | "backtick";
export type GaussdbConnectionMode = "native" | "m-jdbc";
export type GaussdbTargetServerType = "master" | "slave" | "any";
export type GaussdbCountQueryDop = 1 | 2 | 4 | 8 | 16;

const GAUSSDB_IDENTIFIER_QUOTE_STYLE_KEY = "gaussdbIdentifierQuoteStyle";
const GAUSSDB_TARGET_SERVER_TYPE_KEY = "gaussdbTargetServerType";
const GAUSSDB_COUNT_QUERY_DOP_KEY = "gaussdbCountQueryDop";
export const GAUSSDB_M_JDBC_DRIVER_PROFILE = "gaussdb-m";
export const GAUSSDB_M_JDBC_DRIVER_CLASS = "com.huawei.gaussdb.jdbc.Driver";

const DATABASE_AS_EXECUTION_SCHEMA_TYPES = new Set<DatabaseType>(["hive", "kyuubi", "impala", "argo", "spark"]);
const CONNECTION_ROOT_SCHEMA_TYPES = new Set<DatabaseType>(["oracle", "dameng", "oceanbase-oracle"]);

const JDBC_DIALECT_MATCHERS: Array<{ type: DatabaseType; patterns: RegExp[] }> = [
  { type: "databend", patterns: [/jdbc:databend:/i, /com\.databend\.jdbc\.DatabendDriver/i, /databend-jdbc/i] },
  { type: "starrocks", patterns: [/starrocks/i] },
  // Phoenix remains a generic JDBC connection, but exposes queryable schemas.
  // Returning `jdbc` keeps its generic SQL behavior while enabling the schema tree.
  { type: "jdbc", patterns: [/phoenix/i] },
  { type: "doris", patterns: [/doris/i] },
  { type: "goldendb", patterns: [/jdbc:goldendb:/i, /goldendb/i] },
  // GBase 8a only: 8s (`gbasedbt`/`jdbc:gbasedbt-sqli`) is Informix-based and must stay on jdbc.
  { type: "gbase", patterns: [/jdbc:gbase:/i, /cn\.gbase\./i, /gbase(?!dbt)(?!8s).*jdbc/i] },
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
  if (isGbase8sProfile(connection.driver_profile)) return undefined;
  const haystack = [connection.driver_profile, connection.driver_label, connection.connection_string, connection.jdbc_driver_class, ...(connection.jdbc_driver_paths ?? []), connection.database_info?.productName, connection.database_info?.serverComment, connection.database_info?.driverName]
    .filter(Boolean)
    .join("\n");
  if (!haystack) return undefined;
  return JDBC_DIALECT_MATCHERS.find((matcher) => matcher.patterns.some((pattern) => pattern.test(haystack)))?.type;
}

export function jdbcDriverProfileUsesSchemaQualification(driverProfile?: string): boolean {
  return inferJdbcDialect({ db_type: "jdbc", driver_profile: driverProfile }) === "jdbc";
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

/**
 * Database type the data-transfer pipeline treats a connection as. Doris-family
 * engines (Doris/SelectDB/StarRocks) are saved as `db_type=mysql` with a
 * doris/starrocks `driver_profile`, and the transfer backend routes them through
 * the MySQL object family (catalog routing is driver_profile-aware); the
 * standalone `doris`/`starrocks` manifest entries are not transfer-capable.
 * Resolve those connections back to their raw db_type so they stay selectable in
 * the transfer dialog and keep the MySQL object kinds — the effective type alone
 * would drop them from the connection list and disable every non-table kind.
 */
export function transferDatabaseTypeForConnection(connection?: JdbcDialectConnection): DatabaseType | undefined {
  const effective = effectiveDatabaseTypeForConnection(connection);
  if (effective === "doris" || effective === "starrocks") return connection?.db_type;
  return effective;
}

export function connectionUsesConnectionRootSchemaMode(connection?: JdbcDialectConnection): boolean {
  const type = effectiveDatabaseTypeForConnection(connection);
  return !!type && CONNECTION_ROOT_SCHEMA_TYPES.has(type);
}

export function connectionShouldLoadIdentifierQuote(connection: JdbcDialectConnection | undefined): boolean {
  if (!connection) return false;
  if (connection.db_type === "gbase" && isGbase8sProfile(connection.driver_profile)) return true;
  if (connection.db_type === "kingbase") return true;
  // Cloud Spanner is dual-dialect: the agent reports a backtick for GoogleSQL and
  // a double quote for PostgreSQL-dialect databases. The backend counts Spanner
  // unconditionally in `uses_connection_identifier_quote`, so the UI must fetch
  // the reported quote or every locally built statement would use the GoogleSQL
  // default against a PostgreSQL-dialect database.
  if (connection.db_type === "spanner") return true;
  if (gaussdbIdentifierQuoteStyle(connection) !== "auto") return false;
  if (connection.db_type === "gaussdb") return true;
  if (connection.db_type !== "jdbc") return false;
  const dialect = inferJdbcDialect(connection);
  return dialect === "jdbc" || ["gaussdb", "opengauss", "postgres"].includes(dialect ?? "");
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

export function gaussdbTargetServerType(connection: JdbcDialectConnection | undefined): GaussdbTargetServerType {
  const external = externalConfigRecord(connection?.external_config);
  return normalizeGaussdbTargetServerType(external[GAUSSDB_TARGET_SERVER_TYPE_KEY]) ?? gaussdbTargetServerTypeFromUrl(connection) ?? "any";
}

export function setGaussdbTargetServerType(connection: Pick<ConnectionConfig, "db_type"> & Partial<Pick<ConnectionConfig, "driver_profile" | "driver_label" | "connection_string" | "jdbc_driver_class" | "jdbc_driver_paths" | "database_info" | "external_config">>, value: GaussdbTargetServerType) {
  const external = externalConfigRecord(connection.external_config);
  external[GAUSSDB_TARGET_SERVER_TYPE_KEY] = value;
  connection.external_config = Object.keys(external).length > 0 ? external : undefined;
}

function normalizeGaussdbTargetServerType(value: unknown): GaussdbTargetServerType | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "master" || normalized === "slave" || normalized === "any" ? normalized : undefined;
}

function gaussdbTargetServerTypeFromUrl(connection: JdbcDialectConnection | undefined): GaussdbTargetServerType | undefined {
  const values = [connection?.url_params, connection?.connection_string?.split("?", 2)[1]?.split("#", 1)[0]];
  for (const value of values) {
    const params = new URLSearchParams((value || "").trim().replace(/^\?/, "").replace(/;/g, "&"));
    for (const [key, paramValue] of params) {
      if (key.toLowerCase() === "targetservertype") {
        return normalizeGaussdbTargetServerType(paramValue);
      }
    }
  }
  return undefined;
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
  if (connectionUsesConnectionRootSchemaMode(connection)) return false;
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

export function connectionUsesSchemaExecutionContext(connection?: JdbcDialectConnection): boolean {
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
  const type = effectiveDatabaseTypeForConnection(connection);
  if (type === "informix") return schema || "";
  if (type === "spanner") return spannerObjectTreeSchema(schema);
  return schema || database;
}

/**
 * Metadata schema for query paths that treat the database name as the schema when a
 * connection exposes no schema level (MySQL, HBase, and the other flat engines).
 * Cloud Spanner is the exception: its database is a resource path, so the blank
 * GoogleSQL schema has to be sent instead of the path. Behavior for every other
 * database type is exactly `schema || database`.
 */
export function connectionDatabaseMetadataSchema(connection: JdbcDialectConnection | undefined, database: string, schema?: string): string {
  if (schema) return schema;
  return effectiveDatabaseTypeForConnection(connection) === "spanner" ? "" : database;
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
  if (type === "spanner") return spannerObjectTreeSchema(schema);
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

export function gaussdbCountQueryDop(connection: JdbcDialectConnection | undefined): GaussdbCountQueryDop {
  const external = externalConfigRecord(connection?.external_config);
  const value = external[GAUSSDB_COUNT_QUERY_DOP_KEY];
  return value === 2 || value === 4 || value === 8 || value === 16 ? value : 1;
}

export function setGaussdbCountQueryDop(connection: Pick<ConnectionConfig, "db_type"> & Partial<Pick<ConnectionConfig, "external_config">>, value: GaussdbCountQueryDop) {
  const external = externalConfigRecord(connection.external_config);
  if (value === 1) {
    delete external[GAUSSDB_COUNT_QUERY_DOP_KEY];
  } else {
    external[GAUSSDB_COUNT_QUERY_DOP_KEY] = value;
  }
  connection.external_config = Object.keys(external).length > 0 ? external : undefined;
}

export function gaussdbCountQueryDopHint(connection: JdbcDialectConnection | undefined): string | undefined {
  const dop = gaussdbCountQueryDop(connection);
  return dop > 1 ? `/*+ set(query_dop ${dop}) */` : undefined;
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
