import { ref } from "vue";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

const STORAGE_KEY = "dbx-sql-file-folders";

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

/** Persist folder paths to localStorage and notify subscribers. */
export function saveSqlFileFolderPaths(paths: string[]): void {
  safeLocalStorageSet(STORAGE_KEY, JSON.stringify(paths));
  sqlFileFoldersVersion.value++;
}

/** Notify subscribers that folder contents may have changed (e.g. after refresh). */
export function notifySqlFileFoldersChanged(): void {
  sqlFileFoldersVersion.value++;
}
