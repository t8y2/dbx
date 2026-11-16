import { formatQueryDuration } from "@/lib/format/duration";
import { supportsSqlFileExecution } from "@/lib/database/databaseFeatureSupport";
import type { BatchStatementExecutionStatus, DatabaseType, QueryMessage, QueryResult, QueryTab } from "@/types/database";

type ExecutionLogTab = Pick<QueryTab, "result" | "results" | "batchSqlExecution" | "isExecuting" | "executionId" | "activeResultRunId" | "executingResultRunId" | "resultRunSelectionExecutionId">;
type Translate = (key: string, params?: Record<string, string | number>) => string;

export function supportsQueryExecutionLog(databaseType?: DatabaseType): boolean {
  return supportsSqlFileExecution(databaseType) && databaseType !== "neo4j" && databaseType !== "nebula";
}

export function isDisplayingHistoricalQueryResult(tab: Pick<ExecutionLogTab, "isExecuting" | "executionId" | "activeResultRunId" | "executingResultRunId" | "resultRunSelectionExecutionId" | "batchSqlExecution">): boolean {
  if (!tab.isExecuting || !tab.executionId || !tab.activeResultRunId || tab.activeResultRunId === tab.executingResultRunId) return false;
  // Auto-keep leaves the previous run selected while producing a new one.
  // Only a projected result run, not that retained grid, owns historical output.
  if (tab.batchSqlExecution?.executionId === tab.executionId) return false;
  return tab.resultRunSelectionExecutionId === tab.executionId;
}

function loggableResult(result: QueryResult, tab: ExecutionLogTab, displayingHistory: boolean): boolean {
  if (result.server_message || result.manual_transaction_no_statement || !result.sourceStatement?.trim()) return false;
  return !tab.isExecuting || displayingHistory || (!!tab.executionId && result.sourceExecutionId === tab.executionId);
}

/** Presence only: badge updates must not serialize or translate the whole batch. */
export function hasQueryExecutionLog(tab: ExecutionLogTab): boolean {
  if (tab.batchSqlExecution?.items.length) return true;
  const results = tab.results?.length ? tab.results : tab.result ? [tab.result] : [];
  const displayingHistory = isDisplayingHistoricalQueryResult(tab);
  return results.some((result) => loggableResult(result, tab, displayingHistory));
}

interface ExecutionLogItem {
  statementIndex: number;
  sql: string;
  status: BatchStatementExecutionStatus;
  affectedRows?: number;
  executionTimeMs?: number;
  error?: string;
}

function knownMetric(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

/** Display-only execution log. Server notices remain separate and unchanged. */
export function queryExecutionLog(tab: ExecutionLogTab, t: Translate): QueryMessage | undefined {
  let items: ExecutionLogItem[];
  if (tab.batchSqlExecution?.items.length) {
    // The displayed batch is also restored when selecting a retained result run.
    // Do not join its items to tab.result: the previous dataset can still be
    // displayed while a new execution is running, and coalesced progress events
    // deliberately leave some per-statement metrics unknown until completion.
    items = tab.batchSqlExecution.items.map((item) => ({
      statementIndex: item.statementIndex,
      sql: item.sql,
      status: item.status,
      affectedRows: item.affectedRows,
      executionTimeMs: item.executionTimeMs,
      error: item.error ?? item.errorDetails?.detail,
    }));
  } else {
    const results = tab.results?.length ? tab.results : tab.result ? [tab.result] : [];
    const displayingHistory = isDisplayingHistoricalQueryResult(tab);
    items = results.flatMap((result, index) => {
      if (!loggableResult(result, tab, displayingHistory)) return [];
      // A procedure may return multiple results for one statement. Keep those
      // responses separate; adding their timings/counts could invent totals.
      return [
        {
          statementIndex: result.statement_index ?? index,
          sql: result.sourceStatement!,
          status: result.execution_error ? "error" : "success",
          affectedRows: result.affected_rows,
          executionTimeMs: result.execution_time_ms,
          error: result.execution_error ? String(result.rows[0]?.[0] ?? result.error?.detail ?? "") : undefined,
        } satisfies ExecutionLogItem,
      ];
    });
  }

  if (!items.length) return undefined;
  // Labels and repeated row counts are stable within one render; keep this
  // cache local so changing the UI language always produces fresh text.
  const sqlLabel = t("executionSummary.sql");
  const timeLabel = t("executionSummary.time");
  const statuses = new Map<BatchStatementExecutionStatus, string>();
  const affectedRowsLabels = new Map<number, string>();
  const blocks = items.map((item) => {
    if (!statuses.has(item.status)) statuses.set(item.status, t(`executionSummary.statuses.${item.status}`));
    const lines = [`${sqlLabel} #${item.statementIndex + 1} · ${statuses.get(item.status)}`, item.sql];
    if (item.status === "success" && knownMetric(item.affectedRows)) {
      if (!affectedRowsLabels.has(item.affectedRows)) affectedRowsLabels.set(item.affectedRows, t("grid.rowsAffected", { count: item.affectedRows }));
      lines.push(`> ${affectedRowsLabels.get(item.affectedRows)}`);
    }
    if ((item.status === "success" || item.status === "error") && knownMetric(item.executionTimeMs)) lines.push(`> ${timeLabel}: ${formatQueryDuration(item.executionTimeMs)}`);
    if (item.status === "error" && item.error) lines.push(`> ${item.error}`);
    return lines.join("\n");
  });
  // One text node keeps large scripts from creating a DOM subtree per statement
  // and lets native select-all/copy include the complete execution log.
  return {
    severity: items.some((item) => item.status === "error") ? "ERROR" : items.some((item) => item.status === "cancelled") ? "WARNING" : "INFO",
    message: blocks.join("\n\n"),
  };
}
