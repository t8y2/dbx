import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export const HBASE_ROW_LIMIT_STORAGE_KEY = "dbx-hbase-row-limit";
export const DEFAULT_HBASE_ROW_LIMIT = "100";
export const HBASE_ROW_LIMIT_OPTIONS = ["50", "100", "200", "500"] as const;

export function normalizeHBaseRowLimit(value: unknown): string {
  const candidate = typeof value === "string" || typeof value === "number" ? String(value) : "";
  return (HBASE_ROW_LIMIT_OPTIONS as readonly string[]).includes(candidate) ? candidate : DEFAULT_HBASE_ROW_LIMIT;
}

export function loadHBaseRowLimit(): string {
  return normalizeHBaseRowLimit(safeLocalStorageGet(HBASE_ROW_LIMIT_STORAGE_KEY));
}

export function saveHBaseRowLimit(value: unknown): string {
  const normalized = normalizeHBaseRowLimit(value);
  safeLocalStorageSet(HBASE_ROW_LIMIT_STORAGE_KEY, normalized);
  return normalized;
}
