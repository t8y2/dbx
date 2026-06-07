import type { DatabaseObjectType, DatabaseType } from "@/types/database";
import * as api from "@/lib/api";

export interface DropObjectSqlOptions {
  databaseType?: DatabaseType;
  objectType: DatabaseObjectType;
  schema?: string | null;
  name: string;
}

export interface TableAdminSqlOptions {
  databaseType?: DatabaseType;
  schema?: string | null;
  tableName: string;
}

export type TableChildObjectType = "COLUMN" | "INDEX" | "FOREIGN_KEY" | "TRIGGER";

export interface DropTableChildObjectSqlOptions {
  databaseType?: DatabaseType;
  objectType: TableChildObjectType;
  schema?: string | null;
  tableName: string;
  name: string;
}

export interface DatabaseNameSqlOptions {
  databaseType?: DatabaseType;
  name: string;
}

export interface SchemaNameSqlOptions {
  databaseType?: DatabaseType;
  name: string;
}

export interface DuplicateTableStructureSqlOptions {
  databaseType?: DatabaseType;
  schema?: string | null;
  sourceName: string;
  targetName: string;
}

export function buildDropObjectSql(options: DropObjectSqlOptions): Promise<string> {
  return api.buildDropObjectSql(options);
}

export function buildDropTableSql(options: TableAdminSqlOptions): Promise<string> {
  return api.buildDropTableSql(options);
}

export function buildDropTableChildObjectSql(options: DropTableChildObjectSqlOptions): Promise<string> {
  return api.buildDropTableChildObjectSql(options);
}

export function buildEmptyTableSql(options: TableAdminSqlOptions): Promise<string> {
  return api.buildEmptyTableSql(options);
}

export function buildTruncateTableSql(options: TableAdminSqlOptions): Promise<string> {
  return api.buildTruncateTableSql(options);
}

export function buildDropDatabaseSql(options: DatabaseNameSqlOptions): Promise<string> {
  return api.buildDropDatabaseSql(options);
}

export function buildCreateSchemaSql(options: SchemaNameSqlOptions): Promise<string> {
  return api.buildCreateSchemaSql(options);
}

export function buildDropSchemaSql(options: SchemaNameSqlOptions): Promise<string> {
  return api.buildDropSchemaSql(options);
}

export function buildDuplicateTableStructureSql(options: DuplicateTableStructureSqlOptions): Promise<string> {
  return api.buildDuplicateTableStructureSql(options);
}
