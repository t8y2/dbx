import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export const MEILISEARCH_TASK_COLUMN_STORAGE_KEY = "dbx:meilisearch:task-columns:v1";

export const MEILISEARCH_TASK_COLUMN_KEYS = ["uid", "index", "type", "status", "details", "enqueuedAt", "startedAt", "finishedAt", "duration"] as const;

export type MeilisearchTaskColumnKey = (typeof MEILISEARCH_TASK_COLUMN_KEYS)[number];

function isTaskColumnKey(value: unknown): value is MeilisearchTaskColumnKey {
  return typeof value === "string" && MEILISEARCH_TASK_COLUMN_KEYS.includes(value as MeilisearchTaskColumnKey);
}

export function loadMeilisearchTaskColumns(): MeilisearchTaskColumnKey[] {
  try {
    const parsed = JSON.parse(safeLocalStorageGet(MEILISEARCH_TASK_COLUMN_STORAGE_KEY) || "null") as { visible?: unknown } | null;
    const visible = Array.isArray(parsed?.visible) ? parsed.visible.filter(isTaskColumnKey) : [];
    return visible.length ? MEILISEARCH_TASK_COLUMN_KEYS.filter((key) => visible.includes(key)) : [...MEILISEARCH_TASK_COLUMN_KEYS];
  } catch {
    return [...MEILISEARCH_TASK_COLUMN_KEYS];
  }
}

export function saveMeilisearchTaskColumns(visible: readonly MeilisearchTaskColumnKey[]): void {
  const normalized = MEILISEARCH_TASK_COLUMN_KEYS.filter((key) => visible.includes(key));
  safeLocalStorageSet(MEILISEARCH_TASK_COLUMN_STORAGE_KEY, JSON.stringify({ version: 1, visible: normalized.length ? normalized : [...MEILISEARCH_TASK_COLUMN_KEYS] }));
}
