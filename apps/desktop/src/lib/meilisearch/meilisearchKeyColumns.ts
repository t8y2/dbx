import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export const MEILISEARCH_KEY_COLUMN_STORAGE_KEY = "dbx:meilisearch:key-columns:v1";
export const MEILISEARCH_KEY_COLUMN_KEYS = ["name", "key", "uid", "actions", "indexes", "expiresAt"] as const;
export type MeilisearchKeyColumnKey = (typeof MEILISEARCH_KEY_COLUMN_KEYS)[number];

function isKeyColumn(value: unknown): value is MeilisearchKeyColumnKey {
  return typeof value === "string" && MEILISEARCH_KEY_COLUMN_KEYS.includes(value as MeilisearchKeyColumnKey);
}

export function loadMeilisearchKeyColumns(): MeilisearchKeyColumnKey[] {
  try {
    const parsed = JSON.parse(safeLocalStorageGet(MEILISEARCH_KEY_COLUMN_STORAGE_KEY) || "null") as { visible?: unknown } | null;
    const visible = Array.isArray(parsed?.visible) ? parsed.visible.filter(isKeyColumn) : [];
    return visible.length ? MEILISEARCH_KEY_COLUMN_KEYS.filter((key) => visible.includes(key)) : [...MEILISEARCH_KEY_COLUMN_KEYS];
  } catch {
    return [...MEILISEARCH_KEY_COLUMN_KEYS];
  }
}

export function saveMeilisearchKeyColumns(visible: readonly MeilisearchKeyColumnKey[]): void {
  const normalized = MEILISEARCH_KEY_COLUMN_KEYS.filter((key) => visible.includes(key));
  safeLocalStorageSet(MEILISEARCH_KEY_COLUMN_STORAGE_KEY, JSON.stringify({ version: 1, visible: normalized.length ? normalized : [...MEILISEARCH_KEY_COLUMN_KEYS] }));
}
