import type { DatabaseType } from "@/types/database.ts";
import * as api from "@/lib/backend/api.ts";
import { isNumericSearchColumn, isTextSearchColumn, parseNumericTerm } from "@/lib/database/databaseSearch.ts";
import type { DatabaseSearchColumnLite } from "@/lib/database/databaseSearchColumns.ts";

/** 单条探测语句最多合并的表数与条件数(双上限任一触顶切批,防巨型语句拖垮解析器)。 */
export const DATABASE_SEARCH_PROBE_TABLE_BATCH_SIZE = 20;
export const DATABASE_SEARCH_PROBE_CONDITION_LIMIT = 500;

export interface DatabaseSearchProbeSqlOptions {
  databaseType?: DatabaseType;
  driverProfile?: string;
  tables: Array<{
    schema?: string;
    tableName: string;
    columns: DatabaseSearchColumnLite[];
  }>;
  term: string;
  limit?: number;
}

export function countProbeConditions(columns: DatabaseSearchColumnLite[], term: string): number {
  const textCount = columns.filter(isTextSearchColumn).length;
  const numericCount = parseNumericTerm(term) ? columns.filter(isNumericSearchColumn).length : 0;
  return textCount + numericCount;
}

/**
 * 计算下一个探测批的结束下标(不含):从 nextIndex 起,受表数/条件数双上限约束;
 * 至少包含一张表,避免零条件批死循环(无列信息的表按 0 条件计,走批内逐表回退)。
 * tasks 直接传每张表的预取列数组(undefined = 无目录信息)。
 */
export function nextProbeChunkEnd(nextIndex: number, endIndex: number, tasks: Array<DatabaseSearchColumnLite[] | undefined>, term: string, options?: { tableBatchSize?: number; conditionLimit?: number }): number {
  const tableBatchSize = options?.tableBatchSize ?? DATABASE_SEARCH_PROBE_TABLE_BATCH_SIZE;
  const conditionLimit = options?.conditionLimit ?? DATABASE_SEARCH_PROBE_CONDITION_LIMIT;
  let end = Math.min(nextIndex, endIndex);
  let conditions = 0;
  let tables = 0;
  while (end < endIndex && tables < tableBatchSize) {
    const taskConditions = tasks[end] ? countProbeConditions(tasks[end]!, term) : 0;
    if (tables > 0 && conditions + taskConditions > conditionLimit) break;
    conditions += taskConditions;
    tables += 1;
    end += 1;
  }
  return Math.max(end, nextIndex + 1 <= endIndex ? nextIndex + 1 : nextIndex);
}

/**
 * 执行一条多表探测语句,返回命中的表下标集合(相对传入 tables)。
 * 语句失败向上抛出,由调用方将该批回退逐表路径。
 */
export async function probeTables(options: {
  databaseType?: DatabaseType;
  driverProfile?: string;
  term: string;
  limit: number;
  tables: DatabaseSearchProbeSqlOptions["tables"];
  buildSql?: typeof api.buildDatabaseSearchProbeSql;
  executeQuery: (sql: string, executionId: string) => Promise<{ columns: string[]; rows: unknown[][] }>;
  executionId: string;
}): Promise<Set<number>> {
  const buildSql = options.buildSql ?? api.buildDatabaseSearchProbeSql;
  const probe = await buildSql({
    databaseType: options.databaseType,
    driverProfile: options.driverProfile,
    tables: options.tables,
    term: options.term,
    limit: options.limit,
  });
  if (!probe?.sql) return new Set();

  const result = await options.executeQuery(probe.sql, options.executionId);
  const headerIndex = new Map<string, number>();
  result.columns.forEach((name, index) => headerIndex.set(name.toLowerCase(), index));
  const labelIndex = headerIndex.get("table_label");
  const hitsIndex = headerIndex.get("hits");
  if (labelIndex === undefined) return new Set();

  // includedIndices[k] 是第 k 个分支(t{k})对应的输入表下标
  const labelToIndex = new Map<string, number>();
  probe.includedIndices.forEach((tableIndex, branch) => {
    labelToIndex.set(`t${branch}`, tableIndex);
  });

  const hits = new Set<number>();
  for (const row of result.rows) {
    const label = String(row[labelIndex] ?? "").trim();
    const tableIndex = labelToIndex.get(label);
    if (tableIndex === undefined) continue;
    const hitCount = hitsIndex === undefined ? 1 : Number(row[hitsIndex] ?? 0);
    if (Number.isFinite(hitCount) && hitCount > 0) hits.add(tableIndex);
  }
  return hits;
}
