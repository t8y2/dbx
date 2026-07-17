import type { DatabaseObjectType, DatabaseType } from "@/types/database";
import * as api from "@/lib/backend/api";

export interface DropObjectSqlOptions {
  databaseType?: DatabaseType;
  objectType: DatabaseObjectType;
  schema?: string | null;
  name: string;
  signature?: string | null;
}

export interface TableAdminSqlOptions {
  databaseType?: DatabaseType;
  schema?: string | null;
  tableName: string;
  cascade?: boolean;
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

export interface DatabasePropertyEditSqlOptions {
  databaseType?: DatabaseType;
  driverProfile?: string | null;
  target: "database" | "schema";
  name: string;
  charset?: string;
  collation?: string;
  comment?: string;
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

const DROP_TABLE_CASCADE_DATABASE_TYPES: readonly DatabaseType[] = ["postgres", "redshift", "gaussdb", "kwdb", "kingbase", "highgo", "vastbase", "opengauss"];
const TRUNCATE_TABLE_CASCADE_DATABASE_TYPES: readonly DatabaseType[] = ["postgres", "gaussdb", "kwdb", "kingbase", "highgo", "vastbase", "opengauss"];

export function supportsDropTableCascade(databaseType?: DatabaseType): boolean {
  return !!databaseType && DROP_TABLE_CASCADE_DATABASE_TYPES.includes(databaseType);
}

export function supportsTruncateTableCascade(databaseType?: DatabaseType): boolean {
  return !!databaseType && TRUNCATE_TABLE_CASCADE_DATABASE_TYPES.includes(databaseType);
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
  return ["postgres", "gaussdb", "kwdb", "kingbase", "highgo", "vastbase", "opengauss", "yashandb"].includes(databaseType || "");
}

export function buildUpdateDatabasePropertiesSql(options: DatabasePropertyEditSqlOptions): Promise<string> {
  return api.buildUpdateDatabasePropertiesSql(options);
}

export function buildGetDatabaseCommentSql(options: DatabaseNameSqlOptions): string {
  if (!supportsSchemaComment(options.databaseType)) {
    throw new Error("Database comments are not supported by this database");
  }
  return ["SELECT pg_catalog.shobj_description(db.oid, 'pg_database') AS comment", "FROM pg_catalog.pg_database db", `WHERE db.datname = ${quoteSqlLiteral(options.name)};`].join("\n");
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

export function buildCreateExtensionSql(name: string, schema?: string | null): string {
  const extName = quotePostgresIdentifier(name);
  if (schema) {
    return `CREATE EXTENSION ${extName} WITH SCHEMA ${quotePostgresIdentifier(schema)};`;
  }
  return `CREATE EXTENSION ${extName};`;
}

export function buildDropExtensionSql(name: string, cascade = false): string {
  const extName = quotePostgresIdentifier(name);
  return cascade ? `DROP EXTENSION ${extName} CASCADE;` : `DROP EXTENSION ${extName};`;
}

export function buildListAvailableExtensionsSql(schema?: string | null): string {
  // pg_available_extensions shows extensions available for installation
  if (schema) {
    return `SELECT name, default_version, comment FROM pg_catalog.pg_available_extensions WHERE installed_version IS NULL ORDER BY name`;
  }
  return `SELECT name, default_version, comment FROM pg_catalog.pg_available_extensions WHERE installed_version IS NULL ORDER BY name`;
}
