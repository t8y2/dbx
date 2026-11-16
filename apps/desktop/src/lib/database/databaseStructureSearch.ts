import type { DatabaseType } from "@/types/database";
import type { ColumnInfo } from "@/types/database";
import { normalizeBackendError } from "@/lib/backend/errorUtils";
import * as api from "@/lib/backend/api.ts";
import { supportsDatabaseStructureSearch as supportsDatabaseStructureSearchCapability, usesDocumentStructureSearch, usesSqlCatalogStructureSearch } from "@/lib/database/databaseStructureSearchCapabilities";

export type DatabaseSearchScope = "data" | "structure";

export interface DatabaseStructureSearchSqlOptions {
  databaseType?: DatabaseType;
  driverProfile?: string;
  database: string;
  schema?: string;
  term: string;
  limit?: number;
  /** Dameng may need a catalog fallback when SYS.SYSOBJECTS is not readable. */
  classifyDamengMaterializedViews?: boolean;
}

export interface DatabaseStructureSearchSql {
  sql: string;
}

export interface DatabaseStructureSearchHit {
  catalog?: string;
  schema?: string;
  tableName: string;
  tableType?: string;
  /** 字段级命中的列名；表注释命中（表级结果行）时为 undefined。 */
  columnName?: string;
  columnComment?: string;
  /** 表自身注释的命中内容，仅当 matchedIn 含 "tableComment" 时有值。 */
  tableComment?: string;
  matchedIn: Array<"name" | "comment" | "tableComment">;
}

export interface DatabaseStructureSearchOptions {
  catalog?: string;
  connectionId: string;
  databaseType: DatabaseType;
  driverProfile?: string;
  database: string;
  schema?: string;
  term: string;
  limit?: number;
  executionId: string;
  shouldAbort?: () => boolean;
  listTables: (schema?: string) => Promise<Array<{ name: string; table_type: string }>>;
  getColumns: (schema: string, tableName: string) => Promise<ColumnInfo[]>;
  executeQuery: (sql: string, executionId: string) => Promise<{ columns: string[]; rows: unknown[][]; execution_error?: true }>;
}

function cleanTerm(term: string): string {
  return term.trim();
}

function termMatches(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function normalizeRow(columns: string[], row: unknown[]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  columns.forEach((column, index) => {
    record[column.toLowerCase()] = row[index];
  });
  return record;
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

export function mapStructureSearchRows(columns: string[], rows: unknown[][], term: string): DatabaseStructureSearchHit[] {
  const query = cleanTerm(term);
  if (!query) return [];
  const hits: DatabaseStructureSearchHit[] = [];
  for (const row of rows) {
    const record = normalizeRow(columns, row);
    const schema = asString(record.object_schema) || undefined;
    const tableName = asString(record.object_name);
    const tableType = asString(record.object_type) || undefined;
    const columnName = asString(record.column_name);
    const columnComment = asString(record.column_comment) || undefined;
    const tableComment = asString(record.table_comment) || undefined;
    if (!tableName) continue;
    const matchedIn: Array<"name" | "comment" | "tableComment"> = [];
    if (columnName && termMatches(columnName, query)) matchedIn.push("name");
    if (columnComment && termMatches(columnComment, query)) matchedIn.push("comment");
    // 表注释命中是表级结果行：column_name 为空，只有 table_comment 参与匹配。
    if (tableComment && termMatches(tableComment, query)) matchedIn.push("tableComment");
    if (!matchedIn.length) continue;
    hits.push({
      schema,
      tableName,
      tableType,
      columnName: columnName || undefined,
      columnComment,
      tableComment,
      matchedIn,
    });
  }
  return hits;
}

export function structureHitPreview(hit: DatabaseStructureSearchHit): string {
  const parts: string[] = [];
  if (hit.matchedIn.includes("name") && hit.columnName) parts.push(hit.columnName);
  if (hit.matchedIn.includes("comment") && hit.columnComment) {
    parts.push(truncateComment(hit.columnComment));
  }
  if (hit.matchedIn.includes("tableComment") && hit.tableComment) {
    parts.push(truncateComment(hit.tableComment));
  }
  return parts.join(" · ") || hit.columnName || "";
}

function truncateComment(comment: string): string {
  const normalized = comment.replace(/\s+/g, " ").trim();
  return normalized.length > 90 ? `${normalized.slice(0, 90)}...` : normalized;
}

export async function buildDatabaseStructureSearchSql(options: DatabaseStructureSearchSqlOptions): Promise<DatabaseStructureSearchSql | null> {
  return api.buildDatabaseStructureSearchSql(options);
}

export async function supportsDatabaseStructureSearchBackend(databaseType?: DatabaseType, driverProfile?: string): Promise<boolean> {
  return api.supportsDatabaseStructureSearch(databaseType, driverProfile);
}

function isDamengStructureSearch(options: DatabaseStructureSearchOptions): boolean {
  const profile = options.driverProfile?.trim().toLocaleLowerCase() || "";
  return options.databaseType === "dameng" || (options.databaseType === "jdbc" && (profile.includes("dameng") || profile.includes("dm")));
}

function isDamengCatalogFallbackError(error: unknown): boolean {
  const backendError = normalizeBackendError(error);
  const code = backendError?.code || "";
  if (/DBX-(?:JDBC-(?:1001|1002|2001|2002|2003|5001)|TXN-)/.test(code)) return false;
  const diagnostics = backendError?.diagnostics || {};
  const text = [error instanceof Error ? error.message : typeof error === "string" ? error : "", backendError?.detail, diagnostics.sqlState, diagnostics.exceptionClass].filter(Boolean).join(" ").toLocaleLowerCase();
  const catalogReference = ["sysobjects", "sys.sysobjects", "all_objects", "all_tab_columns", "all_tab_comments", "all_col_comments"].some((marker) => text.includes(marker));
  const permissionError = ["权限", "无权", "permission", "privilege", "access denied", "not authorized", "insufficient privilege"].some((marker) => text.includes(marker));
  if (diagnostics.vendorCode === -5669 || (catalogReference && permissionError)) return true;
  const missingCatalog = ["does not exist", "not found", "不存在", "无法解析", "invalid object", "invalid table", "无效的对象"].some((marker) => text.includes(marker));
  return catalogReference && missingCatalog;
}

function structureSearchSqlOptions(options: DatabaseStructureSearchOptions, classifyDamengMaterializedViews?: boolean): DatabaseStructureSearchSqlOptions {
  return {
    databaseType: options.databaseType,
    driverProfile: options.driverProfile,
    database: options.database,
    schema: options.schema,
    term: options.term,
    limit: options.limit,
    ...(isDamengStructureSearch(options) && classifyDamengMaterializedViews !== undefined ? { classifyDamengMaterializedViews } : {}),
  };
}

export async function runSqlCatalogStructureSearch(options: DatabaseStructureSearchOptions): Promise<DatabaseStructureSearchHit[]> {
  if (options.shouldAbort?.()) return [];
  const dameng = isDamengStructureSearch(options);
  let query = await buildDatabaseStructureSearchSql(structureSearchSqlOptions(options, dameng ? true : undefined));
  if (!query?.sql || options.shouldAbort?.()) return [];

  let damengFallbackAttempted = false;
  const runDamengFallback = async (): Promise<{ columns: string[]; rows: unknown[][]; execution_error?: true } | undefined> => {
    if (damengFallbackAttempted) return undefined;
    damengFallbackAttempted = true;
    if (options.shouldAbort?.()) return undefined;
    const fallbackQuery = await buildDatabaseStructureSearchSql(structureSearchSqlOptions(options, false));
    if (!fallbackQuery?.sql || options.shouldAbort?.()) return undefined;
    try {
      return await options.executeQuery(fallbackQuery.sql, options.executionId);
    } catch {
      return undefined;
    }
  };

  let result: { columns: string[]; rows: unknown[][]; execution_error?: true } | undefined;
  try {
    result = await options.executeQuery(query.sql, options.executionId);
  } catch (error) {
    if (!dameng || !isDamengCatalogFallbackError(error)) return [];
    result = await runDamengFallback();
  }
  if (result?.execution_error && dameng && !damengFallbackAttempted) result = await runDamengFallback();
  if (!result || options.shouldAbort?.() || result.execution_error) return [];
  return mapStructureSearchRows(result.columns, result.rows, options.term).map((hit) => (options.catalog ? { ...hit, catalog: options.catalog } : hit));
}

async function runDocumentStructureSearch(options: DatabaseStructureSearchOptions): Promise<DatabaseStructureSearchHit[]> {
  const query = cleanTerm(options.term);
  if (!query || options.shouldAbort?.()) return [];
  const limit = Math.min(5000, Math.max(1, options.limit ?? 200));
  const hits: DatabaseStructureSearchHit[] = [];
  const tables = await options.listTables(options.schema);
  for (const table of tables) {
    if (options.shouldAbort?.()) return hits;
    if (hits.length >= limit) break;
    const schema = options.schema || options.database;
    let columns: ColumnInfo[] = [];
    try {
      columns = await options.getColumns(schema, table.name);
    } catch {
      continue;
    }
    for (const column of columns) {
      const matchedIn: Array<"name" | "comment"> = [];
      if (termMatches(column.name, query)) matchedIn.push("name");
      const comment = column.comment ?? undefined;
      if (termMatches(comment, query)) matchedIn.push("comment");
      if (!matchedIn.length) continue;
      hits.push({
        schema: options.schema,
        tableName: table.name,
        tableType: table.table_type,
        columnName: column.name,
        columnComment: comment,
        matchedIn,
      });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

export async function runDatabaseStructureSearch(options: DatabaseStructureSearchOptions): Promise<DatabaseStructureSearchHit[]> {
  if (usesSqlCatalogStructureSearch(options.databaseType)) {
    return runSqlCatalogStructureSearch(options);
  }
  if (usesDocumentStructureSearch(options.databaseType)) {
    return runDocumentStructureSearch(options);
  }
  return [];
}

export function effectiveDatabaseSearchScope(requested: DatabaseSearchScope, dbType?: DatabaseType, driverProfile?: string | null): DatabaseSearchScope {
  if (requested !== "structure") return "data";
  if (!supportsDatabaseStructureSearchCapability(dbType, driverProfile)) return "data";
  return "structure";
}

/** Sync guard for UI; mirrors backend catalog support for SQL engines and known document engines. */
export function supportsDatabaseStructureSearchFromManifest(dbType?: DatabaseType, driverProfile?: string | null): boolean {
  return supportsDatabaseStructureSearchCapability(dbType, driverProfile);
}
