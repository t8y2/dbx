import type { DatabaseType } from "@/types/database";

export const SCHEMA_AWARE_TYPES = new Set<DatabaseType>([
  "postgres",
  "sqlserver",
  "oracle",
  "redshift",
  "dameng",
  "gaussdb",
  "kwdb",
  "kingbase",
  "highgo",
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
  "snowflake",
  "trino",
  "prestosql",
  "hive",
  "databend",
  "db2",
  "informix",
  "xugu",
  "oscar",
  "iotdb",
  "iris",
  "duckdb",
]);

export const SINGLE_DATABASE_TYPES = new Set<DatabaseType>(["oracle", "dameng", "firebird", "oceanbase-oracle", "access", "questdb"]);

export const FETCH_FIRST_TYPES = new Set<DatabaseType>(["oracle", "dameng"]);

export const TREE_SCHEMA_TYPES = new Set<DatabaseType>([
  "postgres",
  "redshift",
  "sqlserver",
  "db2",
  "gaussdb",
  "kwdb",
  "kingbase",
  "highgo",
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
  "informix",
  "xugu",
  "oscar",
  "iris",
  "duckdb",
]);

export const DATABASE_OBJECT_TREE_TYPES = new Set<DatabaseType>(["jdbc"]);

export const PG_LIKE_STRUCTURE_TYPES = new Set<DatabaseType>(["postgres", "redshift", "gaussdb", "kwdb", "opengauss", "questdb"]);

export const DIAGRAM_SQL_TYPES = new Set<DatabaseType>(["mysql", "postgres", "sqlite", "rqlite", "turso", "sqlserver", "oracle", "redshift", "dameng", "gaussdb", "kwdb", "opengauss", "questdb", "oceanbase-oracle"]);
