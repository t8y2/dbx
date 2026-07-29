import type { ConnectionConfig } from "@/types/database";

const SQLITE_FILE_EXTENSION_RE = /\.(?:db|db3|sqlite|sqlite3)(?:[?#].*)?$/i;
const WINDOWS_DRIVE_PATH_RE = /^[a-z]:[\\/]/i;

export function isSqliteFileNamespace(value: string | undefined): boolean {
  const normalized = value?.trim() || "";
  if (!normalized) return false;

  const lower = normalized.toLowerCase();
  return (
    lower === ":memory:" ||
    lower.startsWith("file:") ||
    lower.startsWith("sqlite:") ||
    WINDOWS_DRIVE_PATH_RE.test(normalized) ||
    normalized.startsWith("/") ||
    normalized.startsWith("\\") ||
    normalized.startsWith("~/") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    SQLITE_FILE_EXTENSION_RE.test(normalized)
  );
}

export function normalizeSqliteNamespace(value: string | undefined): string {
  const normalized = value?.trim() || "";
  return !normalized || isSqliteFileNamespace(normalized) ? "main" : normalized;
}

export function normalizeStoredConnectionDatabase(dbType: ConnectionConfig["db_type"], database: string | undefined): string | undefined {
  return dbType === "sqlite" ? undefined : database;
}
