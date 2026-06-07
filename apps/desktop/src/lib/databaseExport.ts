import type { DatabaseType, QueryResult } from "../types/database.ts";
import * as api from "./api.ts";
import { buildTableSelectSql } from "./tableSelectSql.ts";
import { uuid } from "./utils.ts";

export const DATABASE_EXPORT_ROW_LIMIT = 10_000;
export const DATABASE_EXPORT_PAGE_SIZE = 500;
export const DATABASE_EXPORT_INSERT_BATCH_SIZE = 100;

export interface ExportedTableSql {
  displayName: string;
  databaseType?: DatabaseType;
  schema?: string;
  tableName?: string;
  qualifiedTableName?: string;
  ddl?: string;
  columns: string[];
  rows: QueryResult["rows"];
  truncated?: boolean;
}

export interface BuildDatabaseSqlExportOptions {
  databaseName: string;
  exportedAt?: Date | string;
  tables: ExportedTableSql[];
  rowLimitPerTable?: number;
  insertBatchSize?: number;
}

export interface BuildExportInsertStatementsOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName?: string;
  qualifiedTableName?: string;
  columns: string[];
  rows: QueryResult["rows"];
  batchSize?: number;
}

export interface BuildExportPageSqlOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName: string;
  limit?: number;
  offset?: number;
}

export function buildInsertStatements(options: BuildExportInsertStatementsOptions): Promise<string[]> {
  return api.buildExportInsertStatements(options);
}

export async function buildExportPageSql(options: BuildExportPageSqlOptions): Promise<string> {
  return buildTableSelectSql({
    databaseType: options.databaseType,
    schema: options.schema,
    tableName: options.tableName,
    limit: options.limit ?? DATABASE_EXPORT_PAGE_SIZE,
    offset: options.offset,
  });
}

export function generateDatabaseExportId(): string {
  return uuid();
}

export function buildDatabaseSqlExport(options: BuildDatabaseSqlExportOptions): Promise<string> {
  return api.buildDatabaseSqlExport({
    ...options,
    exportedAt: options.exportedAt instanceof Date ? options.exportedAt.toISOString() : options.exportedAt,
  });
}
