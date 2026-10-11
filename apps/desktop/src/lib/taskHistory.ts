import type { TaskEndpointSnapshot, TaskItemStatus, TaskRunListQuery, TaskRunStatus } from "@/lib/backend/tauri";

export interface TaskRunFilterDraft {
  fromDate: string;
  throughDate: string;
  sourceQuery: string;
  targetQuery: string;
  status: TaskRunStatus | "";
}

function localDateBoundary(value: string, nextDay = false): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
  if (nextDay) date.setDate(date.getDate() + 1);
  return date.toISOString();
}

/** Convert local calendar-date filters to inclusive UTC start / exclusive UTC end bounds. */
export function taskRunQueryFromFilters(filters: TaskRunFilterDraft): TaskRunListQuery {
  const query: TaskRunListQuery = { taskType: "transfer" };
  if (filters.fromDate) query.startedAtFrom = localDateBoundary(filters.fromDate);
  if (filters.throughDate) query.startedAtBefore = localDateBoundary(filters.throughDate, true);
  const sourceQuery = filters.sourceQuery.trim();
  const targetQuery = filters.targetQuery.trim();
  if (sourceQuery) query.sourceQuery = sourceQuery;
  if (targetQuery) query.targetQuery = targetQuery;
  if (filters.status) query.status = filters.status;
  return query;
}

export function formatTaskEndpoint(endpoint: TaskEndpointSnapshot): string {
  return [endpoint.databaseType, endpoint.catalog, endpoint.database, endpoint.schema].filter((part): part is string => !!part?.trim()).join(" · ");
}

export function formatTaskTimestamp(value: string | null | undefined, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function taskRunElapsedMs(startedAt: string, finishedAt: string | null | undefined): number | null {
  if (!finishedAt) return null;
  const start = new Date(startedAt).getTime();
  const finish = new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return null;
  return finish - start;
}

export function isUnfinishedTaskItem(status: TaskItemStatus): boolean {
  return status !== "succeeded";
}
