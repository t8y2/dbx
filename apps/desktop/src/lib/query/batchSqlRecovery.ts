import type { BatchSqlExecution, QueryResult, QueryTab } from "@/types/database";

export type BatchSqlRecoveryAction = "retry" | "skip" | "skip-all";

export interface BatchSqlRecoveryState {
  failedStatementIndex: number;
  remainingStatementCount: number;
}

function isRecoverableStatementError(batch: BatchSqlExecution, statementIndex: number): boolean {
  const error = batch.items[statementIndex]?.errorDetails;
  return error?.code === "DBX-JDBC-4001" || error?.diagnostics?.category === "sql";
}

export function batchSqlRecoveryState(tab: Pick<QueryTab, "autoCommit" | "batchSqlExecution" | "isExecuting">): BatchSqlRecoveryState | undefined {
  const batch = tab.batchSqlExecution;
  if (!batch || tab.isExecuting || tab.autoCommit === false || batch.recoveryDismissed === true) return undefined;

  for (let failedStatementIndex = batch.items.length - 1; failedStatementIndex >= 0; failedStatementIndex -= 1) {
    if (batch.items[failedStatementIndex]?.status !== "error" || !isRecoverableStatementError(batch, failedStatementIndex)) continue;
    const remainingStatementCount = batch.items.slice(failedStatementIndex + 1).filter((item) => item.status === "skipped" || item.status === "pending").length;
    if (remainingStatementCount > 0) return { failedStatementIndex, remainingStatementCount };
  }
  return undefined;
}

export function prepareBatchSqlRecovery(batch: BatchSqlExecution, executionId: string, startStatementIndex: number): BatchSqlExecution {
  const resumed: BatchSqlExecution = {
    ...batch,
    executionId,
    finishedAt: undefined,
    recoveryDismissed: false,
    items: batch.items.map((item) => ({ ...item })),
  };

  for (let index = startStatementIndex; index < resumed.items.length; index += 1) {
    const item = resumed.items[index]!;
    item.status = index === startStatementIndex ? "running" : "pending";
    item.executionTimeMs = undefined;
    item.affectedRows = undefined;
    item.error = undefined;
    item.errorDetails = undefined;
  }
  resumed.completed = resumed.items.filter((item) => item.status === "success" || item.status === "error").length;
  return resumed;
}

export function batchSqlRecoverySql(batch: BatchSqlExecution, startStatementIndex: number): { sql: string; sourceOffset: number } | undefined {
  const item = batch.items[startStatementIndex];
  if (!item) return undefined;
  const relativeFrom = item.from - batch.sourceOffset;
  if (relativeFrom < 0 || relativeFrom >= batch.submittedSql.length) return undefined;
  return { sql: batch.submittedSql.slice(relativeFrom), sourceOffset: item.from };
}

export function offsetBatchQueryResultIndexes(results: QueryResult[], statementOffset: number): QueryResult[] {
  if (statementOffset === 0) return results;
  for (const [fallbackIndex, result] of results.entries()) {
    result.statement_index = statementOffset + (Number.isInteger(result.statement_index) ? result.statement_index! : fallbackIndex);
  }
  return results;
}

export function mergeBatchQueryResults(previous: QueryResult[], resumed: QueryResult[]): QueryResult[] {
  if (resumed.length === 0) return previous;
  const resumedStart = Math.min(...resumed.map((result, fallbackIndex) => (Number.isInteger(result.statement_index) ? result.statement_index! : fallbackIndex)));
  const retained = previous.filter((result, fallbackIndex) => (Number.isInteger(result.statement_index) ? result.statement_index! : fallbackIndex) < resumedStart);
  return [...retained, ...resumed];
}
