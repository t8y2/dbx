export type MeilisearchOverviewSectionStatus = "available" | "forbidden" | "unsupported" | "error";

export interface OverviewSection<T> {
  status: MeilisearchOverviewSectionStatus;
  data?: T | null;
  message?: string | null;
}

export interface MeilisearchHealthOverview {
  status: string;
}

export interface MeilisearchVersionOverview {
  pkgVersion?: string | null;
  commitSha?: string | null;
  commitDate?: string | null;
}

export interface MeilisearchStatsOverview {
  databaseSize?: number | null;
  usedDatabaseSize?: number | null;
  lastUpdate?: string | null;
  indexCount: number;
  documentCount: number;
  indexingCount: number;
}

export interface MeilisearchTopIndex {
  uid: string;
  numberOfDocuments: number;
  isIndexing: boolean;
}

export interface MeilisearchSystemOverview {
  health: OverviewSection<MeilisearchHealthOverview>;
  version: OverviewSection<MeilisearchVersionOverview>;
  stats: OverviewSection<MeilisearchStatsOverview>;
  taskCounts: OverviewSection<Record<string, number>>;
  keyCount: OverviewSection<number>;
  topIndexes: OverviewSection<MeilisearchTopIndex[]>;
  refreshedAt: string;
}

export interface KeyListItem {
  uid: string;
  /** Plaintext key returned by Meilisearch. Keep it in memory only. */
  key: string;
  name?: string | null;
  description?: string | null;
  maskedKey: string;
  actions: string[];
  indexes: string[];
  expiresAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface CreatedKey extends KeyListItem {}

export interface KeyPage {
  results: KeyListItem[];
  offset: number;
  limit: number;
  total: number;
}

export interface KeyCreateInput {
  uid?: string | null;
  name?: string | null;
  description?: string | null;
  actions: string[];
  indexes: string[];
  expiresAt: string | null;
}

export interface KeyUpdateInput {
  name?: string | null;
  description?: string | null;
}

export interface TaskSelector {
  uids?: number[];
  batchUids?: number[];
  canceledBy?: number[];
  indexUids?: string[];
  statuses?: string[];
  types?: string[];
  afterEnqueuedAt?: string;
  beforeEnqueuedAt?: string;
  afterStartedAt?: string;
  beforeStartedAt?: string;
  afterFinishedAt?: string;
  beforeFinishedAt?: string;
}

export interface MeilisearchTask {
  uid: number;
  batchUid?: number | null;
  indexUid?: string | null;
  status: string;
  type: string;
  canceledBy?: number | null;
  details?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  duration?: string | null;
  enqueuedAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  [key: string]: unknown;
}

export interface TaskPage {
  results: MeilisearchTask[];
  total: number;
  limit: number;
  from?: number | null;
  next?: number | null;
}

export interface EnqueuedTaskSummary {
  taskUid: number;
  indexUid?: string | null;
  status: string;
  type: string;
  enqueuedAt?: string | null;
}

export interface TaskListInput {
  selector: TaskSelector;
  from?: number | null;
  limit?: number;
}

export const MEILISEARCH_TASK_STATUS_OPTIONS = [
  { value: "succeeded", label: "✅ Succeeded" },
  { value: "processing", label: "⚡ Processing" },
  { value: "failed", label: "❌ Failed" },
  { value: "enqueued", label: "🔀 Enqueued" },
  { value: "canceled", label: "🚫 Canceled" },
] as const;

export function meilisearchTaskStatusLabel(status: string): string {
  return MEILISEARCH_TASK_STATUS_OPTIONS.find((option) => option.value === status.toLowerCase())?.label ?? status;
}

export function formatMeilisearchTaskDateTime(value: string | null | undefined, locale?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatDurationUnit(value: number, unit: "day" | "hour" | "minute" | "second" | "millisecond", locale?: string, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits }).format(value);
}

export function formatMeilisearchTaskDuration(value: string | null | undefined, locale?: string): string {
  if (!value) return "-";
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(value);
  if (!match) return value;
  const totalSeconds = Number(match[1] || 0) * 86_400 + Number(match[2] || 0) * 3_600 + Number(match[3] || 0) * 60 + Number(match[4] || 0);
  if (!Number.isFinite(totalSeconds)) return value;
  if (totalSeconds < 1) return formatDurationUnit(Math.round(totalSeconds * 1_000), "millisecond", locale);
  if (totalSeconds < 60) return formatDurationUnit(totalSeconds, "second", locale, 2);
  if (totalSeconds < 3_600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.round(totalSeconds % 60);
    return seconds ? `${formatDurationUnit(minutes, "minute", locale)} ${formatDurationUnit(seconds, "second", locale)}` : formatDurationUnit(minutes, "minute", locale);
  }
  if (totalSeconds < 86_400) {
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.round((totalSeconds % 3_600) / 60);
    return minutes ? `${formatDurationUnit(hours, "hour", locale)} ${formatDurationUnit(minutes, "minute", locale)}` : formatDurationUnit(hours, "hour", locale);
  }
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.round((totalSeconds % 86_400) / 3_600);
  return hours ? `${formatDurationUnit(days, "day", locale)} ${formatDurationUnit(hours, "hour", locale)}` : formatDurationUnit(days, "day", locale);
}

export function formatMeilisearchTaskDetails(details: Record<string, unknown> | null | undefined, labels: Partial<Record<string, string>> = {}): string {
  if (!details || !Object.keys(details).length) return "-";
  return Object.entries(details)
    .map(([key, value]) => `${labels[key] || key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" · ");
}

export function hasExplicitTaskSelector(selector: TaskSelector): boolean {
  return Object.entries(selector).some(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    return typeof value === "string" ? value.trim().length > 0 : value !== null && value !== undefined;
  });
}

export function withFixedTaskIndex(selector: TaskSelector, fixedIndexUid?: string): TaskSelector {
  return fixedIndexUid ? { ...selector, indexUids: [fixedIndexUid] } : selector;
}

export type TaskMutationKind = "cancel" | "delete";

function normalizeStrings(values: string[] | undefined, lowercase = false): string[] | undefined {
  if (!values) return undefined;
  const normalized = values
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => (lowercase ? value.toLowerCase() : value))
    .sort();
  const unique = [...new Set(normalized)];
  return unique.length ? unique : undefined;
}

function normalizeNumbers(values: number[] | undefined): number[] | undefined {
  if (!values) return undefined;
  const unique = [...new Set(values.filter(Number.isFinite))].sort((left, right) => left - right);
  return unique.length ? unique : undefined;
}

export function normalizeTaskSelector(selector: TaskSelector): TaskSelector {
  const normalized: TaskSelector = {
    uids: normalizeNumbers(selector.uids),
    batchUids: normalizeNumbers(selector.batchUids),
    canceledBy: normalizeNumbers(selector.canceledBy),
    indexUids: normalizeStrings(selector.indexUids),
    statuses: normalizeStrings(selector.statuses, true),
    types: normalizeStrings(selector.types),
    afterEnqueuedAt: selector.afterEnqueuedAt?.trim() || undefined,
    beforeEnqueuedAt: selector.beforeEnqueuedAt?.trim() || undefined,
    afterStartedAt: selector.afterStartedAt?.trim() || undefined,
    beforeStartedAt: selector.beforeStartedAt?.trim() || undefined,
    afterFinishedAt: selector.afterFinishedAt?.trim() || undefined,
    beforeFinishedAt: selector.beforeFinishedAt?.trim() || undefined,
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined)) as TaskSelector;
}

/** Mirrors the backend's final mutation selector, including its status safety intersection. */
export function normalizeTaskMutationSelector(selector: TaskSelector, kind: TaskMutationKind): TaskSelector | null {
  const normalized = normalizeTaskSelector(selector);
  if (!hasExplicitTaskSelector(normalized)) return null;
  const allowed = kind === "cancel" ? ["enqueued", "processing"] : ["succeeded", "failed", "canceled"];
  const statuses = normalized.statuses?.length ? allowed.filter((status) => normalized.statuses?.includes(status)) : allowed;
  if (!statuses.length) return null;
  return { ...normalized, statuses };
}
