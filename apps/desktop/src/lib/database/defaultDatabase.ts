import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { usesTreeSchemaMode } from "@/lib/database/databaseCapabilities";

export const TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE = "__dbx_tree_schema_default_database__";
export const EMPTY_DATABASE_SELECT_VALUE = "__dbx_empty_database__";

export function resolveDefaultDatabase(connection: Pick<ConnectionConfig, "database"> & Partial<Pick<ConnectionConfig, "db_type">>, options: string[]): string {
  if (connection.db_type === "cloudflare-d1") return "main";
  return connection.database || options[0] || "";
}

export function isTreeSchemaDefaultDatabase(dbType: DatabaseType | undefined, database: string): boolean {
  return database === "" && usesTreeSchemaMode(dbType);
}

export function encodeSelectableDatabaseValue(dbType: DatabaseType | undefined, database: string): string {
  if (isTreeSchemaDefaultDatabase(dbType, database)) return TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE;
  return database === "" ? EMPTY_DATABASE_SELECT_VALUE : database;
}

export function decodeSelectableDatabaseValue(dbType: DatabaseType | undefined, value: string): string {
  if (value === TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE && usesTreeSchemaMode(dbType)) return "";
  if (value === EMPTY_DATABASE_SELECT_VALUE) return "";
  return value;
}

export function formatDatabaseLabel(connection: Pick<ConnectionConfig, "db_type"> | undefined, database: string, labels: { defaultDatabase: string; noDatabase: string }): string {
  if (connection?.db_type === "redis" && database !== "") return `db${database}`;
  if (isTreeSchemaDefaultDatabase(connection?.db_type, database)) return labels.defaultDatabase;
  return database || labels.noDatabase;
}

export function isDefaultDatabase(connection: (Pick<ConnectionConfig, "database"> & Partial<Pick<ConnectionConfig, "db_type">>) | undefined, database: string): boolean {
  if (connection?.db_type === "cloudflare-d1") return database === "main";
  return !!connection?.database && !!database && connection.database === database;
}
