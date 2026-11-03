import type { DatabaseType } from "@/types/database.ts";
import * as api from "@/lib/backend/api.ts";
import { supportsBulkDatabaseSearch } from "@/lib/database/databaseSearchCapabilities.ts";

/** 批量取列的最小列形状:数据搜索路径只消费 name / data_type / is_primary_key。 */
export interface DatabaseSearchColumnLite {
  name: string;
  data_type: string;
  is_primary_key: boolean;
}

export interface DatabaseSearchColumnsSqlOptions {
  databaseType?: DatabaseType;
  database: string;
  schema?: string;
}

/** (schema, 表名) → 列列表。键统一小写兜底:listTables 与目录行大小写偶有差异。 */
export type SearchColumnsByTable = Map<string, DatabaseSearchColumnLite[]>;

export function searchColumnsTableKey(schema: string | undefined, database: string, tableName: string): string {
  const owner = (schema && schema.trim()) || database;
  return `${owner.toLowerCase()}\n${tableName.toLowerCase()}`;
}

export function findSearchColumns(map: SearchColumnsByTable, schema: string | undefined, database: string, tableName: string): DatabaseSearchColumnLite[] | undefined {
  return map.get(searchColumnsTableKey(schema, database, tableName));
}

function isTruthyPrimaryKey(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.trim().toLowerCase() === "1" || value.trim().toLowerCase() === "true";
  return false;
}

/**
 * 一次目录查询取回整个 schema 的列信息并按表分组。
 * 任何失败(方言不支持、目录视图不可见、执行出错)都返回空 Map,
 * 调用方对缺列的表逐表回退 getColumns——绝不抛错中断搜索。
 */
export async function fetchDatabaseSearchColumns(options: {
  databaseType?: DatabaseType;
  database: string;
  schema?: string;
  buildSql?: typeof api.buildDatabaseSearchColumnsSql;
  executeQuery: (sql: string, executionId: string) => Promise<{ columns: string[]; rows: unknown[][]; truncated?: boolean }>;
  executionId: string;
}): Promise<SearchColumnsByTable> {
  const map: SearchColumnsByTable = new Map();
  if (!supportsBulkDatabaseSearch(options.databaseType)) return map;

  try {
    const buildSql = options.buildSql ?? api.buildDatabaseSearchColumnsSql;
    const built = await buildSql({
      databaseType: options.databaseType,
      database: options.database,
      schema: options.schema,
    });
    if (!built?.sql) return map;

    const result = await options.executeQuery(built.sql, options.executionId);
    // The catalog query rides the backend's default row cap (10k). A truncation
    // can land mid-table, and a table seen with only part of its columns would
    // make the probe miss keywords in the dropped columns — silently skipping
    // that table. Drop the whole catalog instead: an empty map sends every
    // table down the per-table getColumns fallback, which is always complete.
    if (result.truncated) return map;
    const headerIndex = new Map<string, number>();
    result.columns.forEach((name, index) => headerIndex.set(name.toLowerCase(), index));
    const tableIndex = headerIndex.get("table_name");
    const columnIndex = headerIndex.get("column_name");
    const typeIndex = headerIndex.get("data_type");
    const primaryKeyIndex = headerIndex.get("is_primary_key");
    if (tableIndex === undefined || columnIndex === undefined || typeIndex === undefined) return map;

    for (const row of result.rows) {
      const tableName = String(row[tableIndex] ?? "").trim();
      const columnName = String(row[columnIndex] ?? "").trim();
      if (!tableName || !columnName) continue;
      const key = searchColumnsTableKey(options.schema, options.database, tableName);
      let columns = map.get(key);
      if (!columns) {
        columns = [];
        map.set(key, columns);
      }
      columns.push({
        name: columnName,
        data_type: String(row[typeIndex] ?? ""),
        is_primary_key: primaryKeyIndex !== undefined && isTruthyPrimaryKey(row[primaryKeyIndex]),
      });
    }
  } catch {
    // 目录查询失败——返回已收集部分,未命中的表由调用方逐表回退
  }
  return map;
}
