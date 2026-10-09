import type { DatabaseType, QueryResult } from "@/types/database.ts";
import { buildTableSelectSql } from "@/lib/table/tableSelectSql.ts";

export const TABLE_DATA_EXPORT_PAGE_SIZE = 10_000;
export const TABLE_DATA_EXPORT_MAX_ROWS = 2_147_483_647;

export interface TableDataExportCursorPageOptions {
  maxRows: number;
  fetchSize: number;
  pageSize: number;
  resultSessionId?: string;
}

export interface FetchTableDataForExportOptions {
  databaseType?: DatabaseType;
  identifierQuote?: string;
  schema?: string;
  tableName: string;
  tableType?: string;
  columns?: string[];
  pageSize?: number;
  useAgentCursor?: boolean;
  buildPageSql?: (options: { databaseType?: DatabaseType; schema?: string; tableName: string; tableType?: string; columns?: string[]; limit: number; offset: number }) => Promise<string> | string;
  executePage: (sql: string, cursorOptions?: TableDataExportCursorPageOptions) => Promise<QueryResult>;
  closeCursor?: (sessionId?: string) => Promise<void>;
}

export async function fetchTableDataForExport(options: FetchTableDataForExportOptions): Promise<QueryResult> {
  const pageSize = Math.max(1, options.pageSize ?? TABLE_DATA_EXPORT_PAGE_SIZE);
  if (options.databaseType === "victoriametrics") {
    const query = await (options.buildPageSql ?? buildTableSelectSql)({
      databaseType: options.databaseType,
      schema: options.schema,
      tableName: options.tableName,
      tableType: options.tableType,
      columns: options.columns,
      limit: pageSize,
      offset: 0,
    });
    return options.executePage(query);
  }
  let offset = 0;
  const rows: QueryResult["rows"] = [];
  let columns: string[] = [];
  let executionTimeMs = 0;
  let sessionId: string | undefined;

  try {
    while (true) {
      const sql = await (options.buildPageSql ?? buildTableSelectSql)({
        databaseType: options.databaseType,
        identifierQuote: options.identifierQuote,
        schema: options.schema,
        tableName: options.tableName,
        tableType: options.tableType,
        columns: options.columns,
        limit: pageSize,
        offset,
      });
      const result = await options.executePage(
        sql,
        options.useAgentCursor
          ? {
              maxRows: TABLE_DATA_EXPORT_MAX_ROWS,
              fetchSize: pageSize,
              pageSize,
              resultSessionId: sessionId,
            }
          : undefined,
      );
      const nextSessionId = result.session_id?.trim() || undefined;
      if (options.useAgentCursor) {
        sessionId = nextSessionId ?? sessionId;
        if (result.truncated || typeof result.has_more !== "boolean") throw new Error("Incomplete cursor result during table export");
        if (result.has_more && !nextSessionId) throw new Error("Result session ended before table export completed");
      }
      if (columns.length === 0) columns = result.columns;
      rows.push(...result.rows);
      executionTimeMs += result.execution_time_ms ?? 0;
      sessionId = nextSessionId;

      if (options.useAgentCursor ? result.has_more !== true : result.rows.length < pageSize) {
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
  } finally {
    if (options.useAgentCursor && options.closeCursor) {
      try {
        await options.closeCursor(sessionId);
      } catch {}
    }
  }
}
