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

export interface SchemaCommentSqlOptions extends SchemaNameSqlOptions {
  comment: string;
}

export interface DuplicateTableStructureSqlOptions {
  databaseType?: DatabaseType;
  schema?: string | null;
  sourceName: string;
  targetName: string;
}

export interface CopyTableDataSqlOptions {
  databaseType?: DatabaseType;
  schema?: string | null;
  sourceName: string;
  targetName: string;
  columns?: string[];
  postgresOverridingSystemValue?: boolean;
  sqlserverIdentityInsert?: boolean;
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

export function supportsSchemaComment(databaseType?: DatabaseType): boolean {
  return databaseType === "postgres";
}

export function buildGetSchemaCommentSql(options: SchemaNameSqlOptions): string {
  if (!supportsSchemaComment(options.databaseType)) {
    throw new Error("Schema comments are not supported by this database");
  }
  return ["SELECT d.description AS comment", "FROM pg_catalog.pg_namespace n", "LEFT JOIN pg_catalog.pg_description d ON d.objoid = n.oid AND d.objsubid = 0 AND d.classoid = 'pg_namespace'::regclass", `WHERE n.nspname = ${quoteSqlLiteral(options.name)};`].join("\n");
}

export function buildSetSchemaCommentSql(options: SchemaCommentSqlOptions): string {
  if (!supportsSchemaComment(options.databaseType)) {
    throw new Error("Schema comments are not supported by this database");
  }
  const comment = options.comment.trim();
  const literal = comment ? quoteSqlLiteral(comment) : "NULL";
  return `COMMENT ON SCHEMA ${quotePostgresIdentifier(options.name)} IS ${literal};`;
}

export function buildDuplicateTableStructureSql(options: DuplicateTableStructureSqlOptions): Promise<string> {
  return api.buildDuplicateTableStructureSql(options);
}

export function buildCopyTableDataSql(options: CopyTableDataSqlOptions): Promise<string> {
  return api.buildCopyTableDataSql(options);
}

function quotePostgresIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
