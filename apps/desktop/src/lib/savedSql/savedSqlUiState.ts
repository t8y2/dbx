import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export const SQL_LIBRARY_EXPANDED_FOLDERS_STORAGE_KEY = "dbx-sql-library-expanded-folders";
export const SQL_LIBRARY_DISPLAY_MODE_STORAGE_KEY = "dbx-sql-library-display-mode";
export const SQL_LIBRARY_EXPANDED_CONNECTIONS_STORAGE_KEY = "dbx-sql-library-expanded-connections";

export type SavedSqlDisplayMode = "folder" | "connection";

export function getSavedSqlDisplayMode(): SavedSqlDisplayMode {
  return safeLocalStorageGet(SQL_LIBRARY_DISPLAY_MODE_STORAGE_KEY) === "connection" ? "connection" : "folder";
}

export function saveSavedSqlDisplayMode(mode: SavedSqlDisplayMode): void {
  safeLocalStorageSet(SQL_LIBRARY_DISPLAY_MODE_STORAGE_KEY, mode === "connection" ? "connection" : "folder");
}

export function getSavedSqlExpandedConnectionIds(): Set<string> {
  try {
    const raw = safeLocalStorageGet(SQL_LIBRARY_EXPANDED_CONNECTIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === "string")) : new Set();
  } catch {
    return new Set();
  }
}

export function saveSavedSqlExpandedConnectionIds(expandedIds: ReadonlySet<string>): void {
  safeLocalStorageSet(SQL_LIBRARY_EXPANDED_CONNECTIONS_STORAGE_KEY, JSON.stringify([...expandedIds]));
}

/**
 * Load the persisted set of expanded folder IDs in the SQL Library panel.
 * Defaults to an empty set so that all folders start collapsed until explicitly expanded.
 */
export function getSavedSqlExpandedFolderIds(): Set<string> {
  try {
    const raw = safeLocalStorageGet(SQL_LIBRARY_EXPANDED_FOLDERS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === "string")) : new Set();
  } catch {
    return new Set();
  }
}

/**
 * Persist the current set of expanded folder IDs in the SQL Library panel.
 */
export function saveSavedSqlExpandedFolderIds(expandedIds: ReadonlySet<string>): void {
  safeLocalStorageSet(SQL_LIBRARY_EXPANDED_FOLDERS_STORAGE_KEY, JSON.stringify([...expandedIds]));
}
