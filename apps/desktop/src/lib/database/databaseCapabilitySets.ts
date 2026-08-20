import type { DatabaseType } from "@/types/database";

export const SCHEMA_AWARE_TYPES = new Set<DatabaseType>([
  "postgres",
  // Cloud Spanner supports named schemas; GoogleSQL's default schema is the empty string, which
  // `spannerObjectTreeSchema` keeps intact through the `schema || database` fallbacks.
  "spanner",
  "sqlserver",
  "oracle",
  "redshift",
  "dameng",
  "gaussdb",
  "kwdb",
  "kingbase",
  "highgo",
  "uxdb",
  "vastbase",
  "yashandb",
  "databricks",
  "saphana",
  "teradata",
  "vertica",
  "exasol",
  "opengauss",
  "oceanbase-oracle",
  "gbase",
  "jdbc",
  "h2",
  "ignite",
  "ignite3",
  "snowflake",
  "trino",
  "prestosql",
  "hive",
  "kyuubi",
  "impala",
  "spark",
  "databend",
  "db2",
  "informix",
  "xugu",
  "oscar",
  "iotdb",
  "iris",
  "duckdb",
]);

// Engines where an object can be addressed as database/catalog.schema.table.
// Keep this narrower than SCHEMA_AWARE_TYPES: PostgreSQL, for example, cannot
// query another database through a three-part name on the same connection.
export const DATABASE_SCHEMA_QUALIFIED_TYPES = new Set<DatabaseType>(["sqlserver", "trino", "prestosql"]);

export const SINGLE_DATABASE_TYPES = new Set<DatabaseType>(["oracle", "dameng", "firebird", "oceanbase-oracle", "access", "questdb", "victoriametrics"]);

export const CLEARABLE_QUERY_SCHEMA_TYPES = new Set<DatabaseType>(["oracle", "dameng", "gaussdb", "oceanbase-oracle"]);

export const FETCH_FIRST_TYPES = new Set<DatabaseType>(["oracle", "dameng"]);

export const TREE_SCHEMA_TYPES = new Set<DatabaseType>([
  "postgres",
  // Cloud Spanner needs the schema level for the same reason it is in SCHEMA_AWARE_TYPES: named
  // schemas exist and are queryable, so the tree has to expose them. Membership here is what makes
  // a database node load schemas instead of tables; SCHEMA_AWARE_TYPES alone only reaches the
  // schema pickers in dialogs. The sites gated on `database === ""` stay unreachable because a
  // Spanner database is always the resource path.
  "spanner",
  "redshift",
  "sqlserver",
  "db2",
  "gaussdb",
  "kwdb",
  "kingbase",
  "highgo",
  "uxdb",
  "vastbase",
  "yashandb",
  "databricks",
  "saphana",
  "teradata",
  "vertica",
  "exasol",
  "opengauss",
  "oceanbase-oracle",
  "gbase",
  "jdbc",
  "trino",
  "prestosql",
  "h2",
  "ignite",
  "ignite3",
  "informix",
  "xugu",
  "oscar",
  "iris",
  "duckdb",
]);

export const DATABASE_OBJECT_TREE_TYPES = new Set<DatabaseType>(["jdbc"]);

export const PG_VACUUM_TYPES = new Set<DatabaseType>(["postgres", "gaussdb", "kwdb", "kingbase", "highgo", "uxdb", "vastbase", "opengauss"]);

export const PG_LIKE_STRUCTURE_TYPES = new Set<DatabaseType>(["postgres", "redshift", "gaussdb", "kwdb", "opengauss", "questdb"]);

export const DIAGRAM_SQL_TYPES = new Set<DatabaseType>(["mysql", "postgres", "sqlite", "rqlite", "turso", "cloudflare-d1", "sqlserver", "oracle", "redshift", "dameng", "gaussdb", "kwdb", "opengauss", "questdb", "oceanbase-oracle"]);
