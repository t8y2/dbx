import { normalizeExternalSqlPath } from "@/lib/sql/sqlFileOpen";

export const EXTERNAL_SQL_FILE_TARGETS_STORAGE_KEY = "dbx-external-sql-file-targets-v1";
export const MAX_EXTERNAL_SQL_FILE_TARGETS = 200;

export interface ExternalSqlFileTarget {
  connectionId: string;
  database: string;
  catalog?: string;
  schema?: string;
}

export function unassociatedExternalSqlFileTarget(): ExternalSqlFileTarget {
  return { connectionId: "", database: "", catalog: undefined, schema: undefined };
}

interface StoredExternalSqlFileTarget extends ExternalSqlFileTarget {
  path: string;
  updatedAt: number;
}

function loadExternalSqlFileTargets(): StoredExternalSqlFileTarget[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(EXTERNAL_SQL_FILE_TARGETS_STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item) =>
          typeof item?.path === "string" &&
          typeof item?.connectionId === "string" &&
          typeof item?.database === "string" &&
          (item?.catalog === undefined || typeof item.catalog === "string") &&
          // Targets written before schemas were remembered carry no schema key at
          // all, so an absent schema stays valid and simply restores as undefined.
          (item?.schema === undefined || typeof item.schema === "string") &&
          typeof item?.updatedAt === "number",
      )
      .map((item) => ({ ...item, catalog: item.catalog, schema: item.schema })) as StoredExternalSqlFileTarget[];
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

export function moveExternalSqlFileTarget(previousPath: string, nextPath: string) {
  const previous = normalizeExternalSqlPath(previousPath);
  const next = normalizeExternalSqlPath(nextPath);
  if (!previous || !next || previous === next) return;
  const targets = loadExternalSqlFileTargets();
  const target = targets.find((item) => item.path === previous);
  const remaining = targets.filter((item) => item.path !== previous && item.path !== next);
  if (!target) {
    saveExternalSqlFileTargets(remaining);
    return;
  }
  saveExternalSqlFileTargets([{ ...target, path: next, updatedAt: Date.now() }, ...remaining].slice(0, MAX_EXTERNAL_SQL_FILE_TARGETS));
}

export function forgetExternalSqlFileTarget(path: string) {
  const normalizedPath = normalizeExternalSqlPath(path);
  if (!normalizedPath) return;
  saveExternalSqlFileTargets(loadExternalSqlFileTargets().filter((item) => item.path !== normalizedPath));
}

export function resolveExternalSqlFileTarget(path: string, connectionExists: (connectionId: string) => boolean, fallback: ExternalSqlFileTarget): ExternalSqlFileTarget {
  const normalizedPath = normalizeExternalSqlPath(path);
  const saved = loadExternalSqlFileTargets().find((item) => item.path === normalizedPath);
  if (!saved || !connectionExists(saved.connectionId)) return fallback;
  return { connectionId: saved.connectionId, database: saved.database, catalog: saved.catalog, schema: saved.schema };
}
