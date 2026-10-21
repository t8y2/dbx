import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export type SqlFileOpenMode = "single" | "double";
const OPEN_MODE_STORAGE_KEY = "dbx-sql-file-open-mode";

export function getSqlFileOpenMode(): SqlFileOpenMode {
  return safeLocalStorageGet(OPEN_MODE_STORAGE_KEY) === "double" ? "double" : "single";
}

export function saveSqlFileOpenMode(mode: SqlFileOpenMode): void {
  safeLocalStorageSet(OPEN_MODE_STORAGE_KEY, mode === "double" ? "double" : "single");
}
