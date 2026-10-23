import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

const STORAGE_KEY = "dbx-sql-library-tree-state";

export function loadSavedSqlTreeState(): Map<string, boolean> {
  try {
    const stored = JSON.parse(safeLocalStorageGet(STORAGE_KEY) ?? "null");
    if (stored?.version !== 1 || !Array.isArray(stored.folders)) return new Map();
    return new Map(stored.folders.filter((entry: unknown): entry is [string, boolean] => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "boolean"));
  } catch {
    return new Map();
  }
}

export function saveSavedSqlTreeState(folders: Map<string, boolean>): void {
  safeLocalStorageSet(STORAGE_KEY, JSON.stringify({ version: 1, folders: [...folders] }));
}
