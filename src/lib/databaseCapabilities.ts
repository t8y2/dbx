import type { DatabaseType } from "@/types/database";

export const SCHEMA_AWARE_TYPES = new Set<DatabaseType>([
  "postgres",
  "sqlserver",
  "oracle",
  "redshift",
  "dameng",
  "gaussdb",
  "jdbc",
]);

export const SQL_FILE_UNSUPPORTED_TYPES = new Set<DatabaseType>(["redis", "mongodb", "elasticsearch"]);

export const DIAGRAM_SUPPORTED_TYPES = new Set<DatabaseType>([
  "mysql",
  "postgres",
  "sqlite",
  "sqlserver",
  "oracle",
  "redshift",
  "dameng",
  "gaussdb",
]);

export const DATABASE_SEARCH_SUPPORTED_TYPES = new Set<DatabaseType>([
  "mysql",
  "postgres",
  "sqlite",
  "sqlserver",
  "oracle",
  "redshift",
  "duckdb",
  "clickhouse",
  "dameng",
  "gaussdb",
]);

export const TABLE_IMPORT_SUPPORTED_TYPES = new Set<DatabaseType>([
  "mysql",
  "postgres",
  "sqlite",
  "duckdb",
  "clickhouse",
  "sqlserver",
  "oracle",
  "doris",
  "starrocks",
  "redshift",
  "dameng",
  "gaussdb",
]);

export const TABLE_STRUCTURE_SUPPORTED_TYPES = new Set<DatabaseType>(["mysql", "postgres", "sqlite", "sqlserver"]);

export const CREATE_DATABASE_SUPPORTED_TYPES = new Set<DatabaseType>([
  "mysql",
  "postgres",
  "sqlserver",
  "clickhouse",
  "oracle",
  "dameng",
  "gaussdb",
  "doris",
  "starrocks",
  "redshift",
]);

export const FIELD_LINEAGE_SUPPORTED_TYPES = new Set<DatabaseType>([
  "mysql",
  "postgres",
  "sqlite",
  "sqlserver",
  "oracle",
  "redshift",
  "dameng",
  "gaussdb",
]);

export const SINGLE_DATABASE_TYPES = new Set<DatabaseType>(["oracle", "dameng"]);

export const FETCH_FIRST_TYPES = new Set<DatabaseType>(["oracle", "dameng"]);

export const TREE_SCHEMA_TYPES = new Set<DatabaseType>(["postgres", "redshift", "sqlserver", "gaussdb", "jdbc"]);

export const PG_LIKE_STRUCTURE_TYPES = new Set<DatabaseType>(["postgres", "redshift", "gaussdb"]);

export const TRANSFER_SQL_TYPES = new Set<DatabaseType>([
  "mysql",
  "postgres",
  "sqlite",
  "sqlserver",
  "oracle",
  "clickhouse",
  "duckdb",
  "dameng",
  "gaussdb",
]);

export const DIAGRAM_SQL_TYPES = new Set<DatabaseType>([
  "mysql",
  "postgres",
  "sqlite",
  "sqlserver",
  "oracle",
  "redshift",
  "dameng",
  "gaussdb",
]);

export function isSchemaAware(dbType?: DatabaseType): boolean {
  return !!dbType && SCHEMA_AWARE_TYPES.has(dbType);
}

export function isSingleDatabase(dbType?: DatabaseType): boolean {
  return !!dbType && SINGLE_DATABASE_TYPES.has(dbType);
}

export function usesFetchFirst(dbType?: DatabaseType): boolean {
  return !!dbType && FETCH_FIRST_TYPES.has(dbType);
}
