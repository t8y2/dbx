export interface QueryExecutionStateLike {
  isExecuting: boolean;
  isCancelling?: boolean;
  executionId?: string;
}

export function canCancelQueryExecution(state: QueryExecutionStateLike): boolean {
  return state.isExecuting && !!state.executionId && !state.isCancelling;
}

export interface QueryResultLoadingStateLike extends QueryExecutionStateLike {
  activeResultRunId?: string;
  /** The result run being updated; null means the execution will create a new run. */
  executingResultRunId?: string | null;
}

export function isActiveResultLoading(state: QueryResultLoadingStateLike): boolean {
  if (!state.isExecuting) return false;
  if (!state.activeResultRunId) return true;
  // Keep unscoped legacy callers conservative while all new executions set an
  // explicit run id (or null when they are producing a new result run).
  if (state.executingResultRunId === undefined) return true;
  return state.executingResultRunId === state.activeResultRunId;
}

export function queryExecutionLabelKey(state: Pick<QueryExecutionStateLike, "isCancelling">): "common.loading" | "common.stopping" {
  return state.isCancelling ? "common.stopping" : "common.loading";
}

/**
 * Whether the stop action should be visible for a running execution.
 *
 * Unlike `canCancelQueryExecution` this stays true while a cancel request is in
 * flight, so the control keeps its place and only switches to the cancelling
 * state instead of disappearing. Executions without an id (for example the
 * metadata/preparation window of a data-tab reload) have nothing to cancel, so
 * the caller must not offer the action there.
 */
export function shouldShowCancelAction(state: QueryExecutionStateLike): boolean {
  return state.isExecuting && !!state.executionId;
}
