import { safeLocalStorageGet, safeLocalStorageSet, safeLocalStorageRemove } from "@/lib/backend/safeStorage";
import { isSqlFilePath, normalizeExternalSqlPath, relocateExternalSqlPathWithinFolder } from "@/lib/sql/sqlFileOpen";

export const RECENT_SQL_FILES_STORAGE_KEY = "dbx-recent-sql-files-v1";
export const MAX_RECENT_SQL_FILES = 10;

export function getRecentSqlFiles(): string[] {
  const raw = safeLocalStorageGet(RECENT_SQL_FILES_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn(`[DBX][storage:parse] ${RECENT_SQL_FILES_STORAGE_KEY}: expected an array`);
      return [];
    }
    const paths: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string" || !isSqlFilePath(item)) continue;
      const path = normalizeExternalSqlPath(item);
      if (path && !paths.includes(path)) paths.push(path);
      if (paths.length === MAX_RECENT_SQL_FILES) break;
    }
    return paths;
  } catch (error) {
    console.warn(`[DBX][storage:parse] ${RECENT_SQL_FILES_STORAGE_KEY}`, error);
    return [];
  }
}

export function recordRecentSqlFile(path: string) {
  const normalized = normalizeExternalSqlPath(path);
  if (!normalized || !isSqlFilePath(normalized)) return;
  safeLocalStorageSet(RECENT_SQL_FILES_STORAGE_KEY, JSON.stringify([normalized, ...getRecentSqlFiles().filter((item) => item !== normalized)].slice(0, MAX_RECENT_SQL_FILES)));
}

export function clearRecentSqlFiles() {
  safeLocalStorageRemove(RECENT_SQL_FILES_STORAGE_KEY);
}

export function relocateRecentSqlFiles(previousPath: string, nextPath: string, isFolder = false) {
  const previous = normalizeExternalSqlPath(previousPath);
  const next = normalizeExternalSqlPath(nextPath);
  if (!previous || !next || previous === next) return;
  const relocated = getRecentSqlFiles().map((path) => {
    if (isFolder) return relocateExternalSqlPathWithinFolder(path, previousPath, nextPath) ?? path;
    return path === previous ? next : path;
  });
  const unique = [...new Set(relocated.filter(isSqlFilePath))].slice(0, MAX_RECENT_SQL_FILES);
  safeLocalStorageSet(RECENT_SQL_FILES_STORAGE_KEY, JSON.stringify(unique));
}
