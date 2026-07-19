export interface UpdateQueryTaskState {
  isExecuting?: boolean;
  explainExecutionId?: string;
}

function normalizedTaskCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function countActiveUpdateBlockingTasks(backgroundTaskCount: number, queryTasks: UpdateQueryTaskState[]): number {
  const activeQueryCount = queryTasks.filter((task) => task.isExecuting || Boolean(task.explainExecutionId?.trim())).length;
  return normalizedTaskCount(backgroundTaskCount) + activeQueryCount;
}

export function shouldBlockAppUpdate(activeTaskCount: number): boolean {
  return normalizedTaskCount(activeTaskCount) > 0;
}
