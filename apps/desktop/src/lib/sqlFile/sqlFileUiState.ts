import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export const SQL_FILE_FOLDERS_UI_STATE_STORAGE_KEY = "dbx-sql-file-folders-ui-state";
export const SQL_FILE_DISPLAY_MODE_STORAGE_KEY = "dbx-sql-file-display-mode";
export const SQL_FILE_EXPANDED_CONNECTIONS_STORAGE_KEY = "dbx-sql-file-expanded-connections";

export type SqlFileDisplayMode = "folder" | "connection";

export function getSqlFileDisplayMode(): SqlFileDisplayMode {
  return safeLocalStorageGet(SQL_FILE_DISPLAY_MODE_STORAGE_KEY) === "connection" ? "connection" : "folder";
}

export function saveSqlFileDisplayMode(mode: SqlFileDisplayMode): void {
  safeLocalStorageSet(SQL_FILE_DISPLAY_MODE_STORAGE_KEY, mode === "connection" ? "connection" : "folder");
}

export function getSqlFileExpandedConnectionIds(): Set<string> {
  try {
    const raw = safeLocalStorageGet(SQL_FILE_EXPANDED_CONNECTIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === "string")) : new Set();
  } catch {
    return new Set();
  }
}

export function saveSqlFileExpandedConnectionIds(expandedIds: ReadonlySet<string>): void {
  safeLocalStorageSet(SQL_FILE_EXPANDED_CONNECTIONS_STORAGE_KEY, JSON.stringify([...expandedIds]));
}

export interface SqlFileFolderUiState {
  collapsed?: boolean;
  expanded?: string[];
}

/**
 * Load the persisted UI state (collapsed root flag and expanded subdirectory paths)
 * for each external SQL file folder.
 */
export function getSqlFileFoldersUiState(): Record<string, SqlFileFolderUiState> {
  try {
    const raw = safeLocalStorageGet(SQL_FILE_FOLDERS_UI_STATE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, SqlFileFolderUiState> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const v = value as { collapsed?: unknown; expanded?: unknown };
      result[key] = {
        collapsed: typeof v.collapsed === "boolean" ? v.collapsed : false,
        expanded: Array.isArray(v.expanded) ? v.expanded.filter((p): p is string => typeof p === "string") : [],
      };
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Persist the UI state for all external SQL file folders.
 */
export function saveSqlFileFoldersUiState(state: Record<string, SqlFileFolderUiState>): void {
  safeLocalStorageSet(SQL_FILE_FOLDERS_UI_STATE_STORAGE_KEY, JSON.stringify(state));
}
