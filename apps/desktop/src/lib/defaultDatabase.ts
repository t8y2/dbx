import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { usesTreeSchemaMode } from "@/lib/databaseCapabilities";

export const TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE = "__dbx_tree_schema_default_database__";

export function resolveDefaultDatabase(connection: Pick<ConnectionConfig, "database">, options: string[]): string {
  return connection.database || options[0] || "";
}

export function isTreeSchemaDefaultDatabase(dbType: DatabaseType | undefined, database: string): boolean {
  return database === "" && usesTreeSchemaMode(dbType);
}

export function encodeSelectableDatabaseValue(dbType: DatabaseType | undefined, database: string): string {
  return isTreeSchemaDefaultDatabase(dbType, database) ? TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE : database;
}

export function decodeSelectableDatabaseValue(dbType: DatabaseType | undefined, value: string): string {
  return value === TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE && usesTreeSchemaMode(dbType) ? "" : value;
}

export function formatDatabaseLabel(connection: Pick<ConnectionConfig, "db_type"> | undefined, database: string, labels: { defaultDatabase: string; noDatabase: string }): string {
  if (connection?.db_type === "redis" && database !== "") return `db${database}`;
  if (isTreeSchemaDefaultDatabase(connection?.db_type, database)) return labels.defaultDatabase;
  return database || labels.noDatabase;
}

export function isDefaultDatabase(connection: Pick<ConnectionConfig, "database"> | undefined, database: string): boolean {
  return !!connection?.database && !!database && connection.database === database;
}
