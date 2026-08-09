import { normalizeExternalSqlPath } from "@/lib/sql/sqlFileOpen";

export const EXTERNAL_SQL_FILE_TARGETS_STORAGE_KEY = "dbx-external-sql-file-targets-v1";
export const MAX_EXTERNAL_SQL_FILE_TARGETS = 200;

export interface ExternalSqlFileTarget {
  connectionId: string;
  database: string;
}

interface StoredExternalSqlFileTarget extends ExternalSqlFileTarget {
  path: string;
  updatedAt: number;
}

function loadExternalSqlFileTargets(): StoredExternalSqlFileTarget[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(EXTERNAL_SQL_FILE_TARGETS_STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is StoredExternalSqlFileTarget => typeof item?.path === "string" && typeof item?.connectionId === "string" && typeof item?.database === "string" && typeof item?.updatedAt === "number");
  } catch {
    return [];
  }
}

function saveExternalSqlFileTargets(targets: StoredExternalSqlFileTarget[]) {
  try {
    localStorage.setItem(EXTERNAL_SQL_FILE_TARGETS_STORAGE_KEY, JSON.stringify(targets));
  } catch {}
}

export function rememberExternalSqlFileTarget(path: string, target: ExternalSqlFileTarget) {
  const normalizedPath = normalizeExternalSqlPath(path);
  if (!normalizedPath) return;
  const remaining = loadExternalSqlFileTargets().filter((item) => item.path !== normalizedPath);
  if (!target.connectionId) {
    saveExternalSqlFileTargets(remaining);
    return;
  }
  saveExternalSqlFileTargets([{ path: normalizedPath, ...target, updatedAt: Date.now() }, ...remaining].slice(0, MAX_EXTERNAL_SQL_FILE_TARGETS));
}

export function resolveExternalSqlFileTarget(path: string, connectionExists: (connectionId: string) => boolean, fallback: ExternalSqlFileTarget): ExternalSqlFileTarget {
  const normalizedPath = normalizeExternalSqlPath(path);
  const saved = loadExternalSqlFileTargets().find((item) => item.path === normalizedPath);
  if (!saved || !connectionExists(saved.connectionId)) return fallback;
  return { connectionId: saved.connectionId, database: saved.database };
}
