import type { ConnectionConfig } from "@/types/database";

const WINDOWS_DRIVE_PATH_RE = /^[a-z]:[\\/]/i;

type SqliteNamespaceConnection = Partial<Pick<ConnectionConfig, "host" | "database">>;

export function isSqliteFileNamespace(value: string | undefined, connection?: SqliteNamespaceConnection): boolean {
  const normalized = value?.trim() || "";
  if (!normalized) return false;

  const lower = normalized.toLowerCase();
  const connectionHost = connection?.host?.trim() || "";
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
    normalized === connectionHost
  );
}

export function normalizeSqliteNamespace(value: string | undefined, connection?: SqliteNamespaceConnection): string {
  const normalized = value?.trim() || "";
  return !normalized || isSqliteFileNamespace(normalized, connection) ? "main" : normalized;
}

export function normalizeStoredConnectionDatabase(dbType: ConnectionConfig["db_type"], database: string | undefined): string | undefined {
  return dbType === "sqlite" ? undefined : database;
}
