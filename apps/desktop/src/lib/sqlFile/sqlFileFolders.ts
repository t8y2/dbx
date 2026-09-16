import { ref } from "vue";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

const STORAGE_KEY = "dbx-sql-file-folders";
const FILTER_STORAGE_KEY = "dbx-sql-file-filter";
export const DEFAULT_SQL_FILE_FILTER = "*.sql";

/**
 * Shared reactive version counter — bumped whenever SQL file folder paths change.
 * Components that cache folder contents (e.g. useQuickOpen) can watch this
 * to know when they should re-read from localStorage and reload.
 */
export const sqlFileFoldersVersion = ref(0);

/** Read the current list of SQL file folder paths from localStorage. */
export function getSqlFileFolderPaths(): string[] {
  try {
    const raw = safeLocalStorageGet(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Read the file-name filter used by the external SQL file browser. */
export function getSqlFileFilter(): string {
  const filter = safeLocalStorageGet(FILTER_STORAGE_KEY)?.trim();
  return filter || DEFAULT_SQL_FILE_FILTER;
}

/** Persist the file-name filter and invalidate cached external file listings. */
export function saveSqlFileFilter(filter: string): void {
  safeLocalStorageSet(FILTER_STORAGE_KEY, filter.trim() || DEFAULT_SQL_FILE_FILTER);
  sqlFileFoldersVersion.value++;
}

/** Persist folder paths to localStorage and notify subscribers. */
export function saveSqlFileFolderPaths(paths: string[]): void {
  safeLocalStorageSet(STORAGE_KEY, JSON.stringify(paths));
  sqlFileFoldersVersion.value++;
}

/** Notify subscribers that folder contents may have changed (e.g. after refresh). */
export function notifySqlFileFoldersChanged(): void {
  sqlFileFoldersVersion.value++;
}
