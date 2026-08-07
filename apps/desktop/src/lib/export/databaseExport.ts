import type { DatabaseType, QueryResult } from "@/types/database.ts";
import * as api from "@/lib/backend/api.ts";
import { buildTableSelectSql } from "@/lib/table/tableSelectSql.ts";
import { uuid } from "@/lib/common/utils.ts";
import { SINGLE_DATABASE_TYPES } from "@/lib/database/databaseCapabilitySets";

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
  driverProfile?: string;
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
  /** 数据库类型，用于判断是否为单数据库架构（如达梦、Oracle）。
   * 对于这类数据库，选中的"数据库"实际上就是 schema 本身，
   * 不应再对每个"数据库"展开所有 schema 做笛卡尔积。 */
  dbType?: DatabaseType;
}

export interface AllDatabaseExportPlanItem {
  database: string;
  schema: string;
  fileStem: string;
  displayName: string;
}

export interface DatabaseBackupSnapshotOptions {
  connectionId: string;
  database: string;
  enabled: boolean;
}

export function buildInsertStatements(options: BuildExportInsertStatementsOptions): Promise<string[]> {
  return api.buildExportInsertStatements(options);
}

export async function buildExportPageSql(options: BuildExportPageSqlOptions): Promise<string> {
  return buildTableSelectSql({
    databaseType: options.databaseType,
    driverProfile: options.driverProfile,
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

export function shouldUseDatabaseBackupSnapshot(databaseType: DatabaseType | undefined, includeData: boolean, desktopRuntime: boolean): boolean {
  return desktopRuntime && includeData && (databaseType === "mysql" || databaseType === "postgres");
}

export async function runDatabaseExportUntilTerminal(request: api.DatabaseExportRequest, onProgress: (progress: api.ExportProgress) => void): Promise<api.ExportProgress> {
  return new Promise<api.ExportProgress>((resolve, reject) => {
    api
      .exportDatabaseSql(request, (progress) => {
        onProgress(progress);
        if (progress.status === "Done" || progress.status === "Cancelled") {
          resolve(progress);
        } else if (progress.status === "Error") {
          reject(new Error(progress.error || "Export failed"));
        }
      })
      .catch(reject);
  });
}

export async function runWithDatabaseBackupSnapshot<T>(options: DatabaseBackupSnapshotOptions, operation: (snapshotSessionId: string | undefined) => Promise<T>, shouldPropagateCleanupError: (result: T) => boolean = () => true): Promise<T> {
  if (!options.enabled) return operation(undefined);

  const snapshot = await api.beginDatabaseBackupSnapshot(options.connectionId, options.database);
  let result: T | undefined;
  let operationCompleted = false;
  try {
    result = await operation(snapshot.sessionId);
    operationCompleted = true;
    return result;
  } finally {
    await api.rollbackManualTransaction(snapshot.sessionId).catch((error) => {
      if (operationCompleted && shouldPropagateCleanupError(result as T)) throw error;
    });
  }
}

export function buildAllDatabaseExportPlan(options: AllDatabaseExportPlanInput): AllDatabaseExportPlanItem[] {
  // 对于 schema-aware 的单库类型（达梦、Oracle、OceanBase-Oracle 等），选中的"数据库"
  // 实际上就是 schema 本身，不应再展开所有 schema 做笛卡尔积，直接将选中项作为 schema 导出。
  // firebird/questdb/access 等单库但非 schema-aware 类型必须走 flatMap 保留真实 database，
  // 否则 database:"" 会覆盖后端 db_config.database 破坏连接。
  const singleDatabase = options.dbType ? SINGLE_DATABASE_TYPES.has(options.dbType) : false;
  if (singleDatabase && options.schemaAware) {
    return options.databases.map((schema) => ({
      database: "",
      schema,
      fileStem: schema,
      displayName: schema,
    }));
  }
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
