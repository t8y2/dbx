import type { DatabaseType, QueryResult } from "@/types/database.ts";
import * as api from "@/lib/backend/api.ts";
import { buildTableSelectSql } from "@/lib/table/tableSelectSql.ts";
import { uuid } from "@/lib/common/utils.ts";

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
  columnTypes?: Array<string | null | undefined>;
  columnExtras?: Array<string | null | undefined>;
  rows: QueryResult["rows"];
  truncated?: boolean;
}

export interface BuildDatabaseSqlExportOptions {
  databaseName: string;
  exportedAt?: Date | string;
  tables: ExportedTableSql[];
  rowLimitPerTable?: number;
  insertBatchSize?: number;
  connectionId?: string;
  database?: string;
  schema?: string;
}

export interface BuildExportInsertStatementsOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName?: string;
  qualifiedTableName?: string;
  columns: string[];
  columnTypes?: Array<string | null | undefined>;
  columnExtras?: Array<string | null | undefined>;
  rows: QueryResult["rows"];
  batchSize?: number;
}

export interface BuildExportPageSqlOptions {
  databaseType?: DatabaseType;
  identifierQuote?: string;
  schema?: string;
  tableName: string;
  limit?: number;
  offset?: number;
}

export interface AllDatabaseExportPlanInput {
  databases: string[];
  schemaAware: boolean;
  schemasByDatabase?: Record<string, string[]>;
}

export interface AllDatabaseExportPlanItem {
  database: string;
  schema: string;
  fileStem: string;
  displayName: string;
}

export function buildInsertStatements(options: BuildExportInsertStatementsOptions): Promise<string[]> {
  return api.buildExportInsertStatements(options);
}

export async function buildExportPageSql(options: BuildExportPageSqlOptions): Promise<string> {
  return buildTableSelectSql({
    databaseType: options.databaseType,
    identifierQuote: options.identifierQuote,
    schema: options.schema,
    tableName: options.tableName,
    limit: options.limit ?? DATABASE_EXPORT_PAGE_SIZE,
    offset: options.offset,
  });
}

export function generateDatabaseExportId(): string {
  return uuid();
}

export function buildAllDatabaseExportPlan(options: AllDatabaseExportPlanInput): AllDatabaseExportPlanItem[] {
  return options.databases.flatMap((database) => {
    const schemas = options.schemaAware ? (options.schemasByDatabase?.[database] ?? []).filter((schema) => schema.trim()) : [database];
    const exportSchemas = schemas.length > 0 ? schemas : [database];
    const includeSchemaInFileName = options.schemaAware && exportSchemas.length > 1;

    return exportSchemas.map((schema) => ({
      database,
      schema,
      fileStem: includeSchemaInFileName ? `${database}.${schema}` : database,
      displayName: includeSchemaInFileName ? `${database}.${schema}` : database,
    }));
  });
}

export function buildDatabaseSqlExport(options: BuildDatabaseSqlExportOptions): Promise<string> {
  return api.buildDatabaseSqlExport({
    ...options,
    exportedAt: options.exportedAt instanceof Date ? options.exportedAt.toISOString() : options.exportedAt,
  });
}
