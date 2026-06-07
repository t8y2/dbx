export interface QueryExecutionStateLike {
  isExecuting: boolean;
  isCancelling?: boolean;
  executionId?: string;
}

export function canCancelQueryExecution(state: QueryExecutionStateLike): boolean {
  return state.isExecuting && !!state.executionId && !state.isCancelling;
}

export function queryExecutionLabelKey(
  state: Pick<QueryExecutionStateLike, "isCancelling">,
): "common.loading" | "common.stopping" {
  return state.isCancelling ? "common.stopping" : "common.loading";
}
