import { ref } from "vue";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export type SqlFileOpenMode = "single" | "double";
const OPEN_MODE_STORAGE_KEY = "dbx-sql-file-open-mode";

function readSqlFileOpenMode(): SqlFileOpenMode {
  return safeLocalStorageGet(OPEN_MODE_STORAGE_KEY) === "double" ? "double" : "single";
}

const sqlFileOpenMode = ref<SqlFileOpenMode>(readSqlFileOpenMode());

export function getSqlFileOpenMode(): SqlFileOpenMode {
  return sqlFileOpenMode.value;
}

export function useSqlFileOpenMode() {
  return sqlFileOpenMode;
}

export function saveSqlFileOpenMode(mode: SqlFileOpenMode): void {
  const normalized = mode === "double" ? "double" : "single";
  sqlFileOpenMode.value = normalized;
  safeLocalStorageSet(OPEN_MODE_STORAGE_KEY, normalized);
}
