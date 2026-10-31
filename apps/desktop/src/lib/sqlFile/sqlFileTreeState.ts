import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { normalizeExternalSqlPath } from "@/lib/sql/sqlFileOpen";

const STORAGE_KEY = "dbx-sql-file-tree-state";

export interface SqlFileTreeState {
  path: string;
  collapsed: boolean;
  expanded: string[];
}

export function loadSqlFileTreeState(): Map<string, SqlFileTreeState> {
  try {
    const stored = JSON.parse(safeLocalStorageGet(STORAGE_KEY) ?? "null");
    if (stored?.version !== 1 || !Array.isArray(stored.folders)) return new Map();
    const folders: SqlFileTreeState[] = stored.folders.filter((folder: unknown): folder is SqlFileTreeState => {
      if (!folder || typeof folder !== "object") return false;
      const value = folder as Partial<SqlFileTreeState>;
      return typeof value.path === "string" && typeof value.collapsed === "boolean" && Array.isArray(value.expanded) && value.expanded.every((path: unknown) => typeof path === "string");
    });
    return new Map(folders.map((folder) => [normalizeExternalSqlPath(folder.path), folder]));
  } catch {
    return new Map();
  }
}

export function saveSqlFileTreeState(folders: SqlFileTreeState[]): void {
  safeLocalStorageSet(STORAGE_KEY, JSON.stringify({ version: 1, folders }));
}
