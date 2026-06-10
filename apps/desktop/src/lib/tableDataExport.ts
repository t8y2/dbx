import type { DatabaseType, QueryResult } from "../types/database.ts";
import { buildTableSelectSql } from "./tableSelectSql.ts";

export const TABLE_DATA_EXPORT_PAGE_SIZE = 10_000;

export interface FetchTableDataForExportOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName: string;
  columns?: string[];
  pageSize?: number;
  buildPageSql?: (options: { databaseType?: DatabaseType; schema?: string; tableName: string; columns?: string[]; limit: number; offset: number }) => Promise<string> | string;
  executePage: (sql: string) => Promise<QueryResult>;
}

export async function fetchTableDataForExport(options: FetchTableDataForExportOptions): Promise<QueryResult> {
  const pageSize = Math.max(1, options.pageSize ?? TABLE_DATA_EXPORT_PAGE_SIZE);
  let offset = 0;
  const rows: QueryResult["rows"] = [];
  let columns: string[] = [];
  let executionTimeMs = 0;

  while (true) {
    const sql = await (options.buildPageSql ?? buildTableSelectSql)({
      databaseType: options.databaseType,
      schema: options.schema,
      tableName: options.tableName,
      columns: options.columns,
      limit: pageSize,
      offset,
    });
    const result = await options.executePage(sql);
    if (columns.length === 0) columns = result.columns;
    rows.push(...result.rows);
    executionTimeMs += result.execution_time_ms ?? 0;

    if (result.rows.length < pageSize) {
      return {
        columns,
        rows,
        affected_rows: 0,
        execution_time_ms: executionTimeMs,
        truncated: false,
        session_id: undefined,
        has_more: false,
      };
    }

    offset += result.rows.length;
  }
}
