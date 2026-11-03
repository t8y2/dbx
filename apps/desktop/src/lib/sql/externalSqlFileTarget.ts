import { normalizeExternalSqlPath } from "@/lib/sql/sqlFileOpen";
import { supportsSqlFileExecution } from "@/lib/database/databaseFeatureSupport";
import type { ConnectionConfig, QueryTab } from "@/types/database";

export const EXTERNAL_SQL_FILE_TARGETS_STORAGE_KEY = "dbx-external-sql-file-targets-v1";
export const MAX_EXTERNAL_SQL_FILE_TARGETS = 200;

export interface ExternalSqlFileTarget {
  connectionId: string;
  database: string;
  catalog?: string;
  schema?: string;
}

type ExternalSqlFileTargetTab = Pick<QueryTab, "id" | "connectionId" | "database" | "catalog" | "schema" | "mode">;
type ExternalSqlFileTargetConnection = Pick<ConnectionConfig, "db_type">;
type ExternalSqlFileConnectionLookup = (connectionId: string) => ExternalSqlFileTargetConnection | undefined;
type ExternalSqlFileTargetOptions = { allowMongoScripts?: boolean };

export function unassociatedExternalSqlFileTarget(): ExternalSqlFileTarget {
  return { connectionId: "", database: "", catalog: undefined, schema: undefined };
}

export function activeTabExternalSqlFileTarget(tabs: readonly ExternalSqlFileTargetTab[], activeTabId: string | null | undefined, getConnection: ExternalSqlFileConnectionLookup, options: ExternalSqlFileTargetOptions = {}): ExternalSqlFileTarget {
  const activeTab = activeTabId ? tabs.find((tab) => tab.id === activeTabId) : undefined;
  const connection = activeTab?.connectionId ? getConnection(activeTab.connectionId) : undefined;
  if (!activeTab || activeTab.mode === "plugin-workbench" || activeTab.mode === "plugin-filesystem" || !connection || !(supportsSqlFileExecution(connection.db_type) || (options.allowMongoScripts === true && connection.db_type === "mongodb"))) return unassociatedExternalSqlFileTarget();
  return {
    connectionId: activeTab.connectionId,
    database: activeTab.database,
    catalog: activeTab.catalog,
    schema: activeTab.schema,
  };
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

export function moveExternalSqlFolderTargets(previousPath: string, nextPath: string) {
  const previous = normalizeExternalSqlPath(previousPath);
  const next = normalizeExternalSqlPath(nextPath);
  if (!previous || !next || previous === next) return;
  const prefix = `${previous}/`;
  const targets = loadExternalSqlFileTargets();
  const moved = targets.filter((item) => item.path === previous || item.path.startsWith(prefix)).map((item) => ({ ...item, path: `${next}${item.path.slice(previous.length)}`, updatedAt: Date.now() }));
  // Historical bindings at the destination must not attach to unrelated files
  // that now occupy that directory, even when the source had no saved binding.
  const remaining = targets.filter((item) => item.path !== previous && !item.path.startsWith(prefix) && item.path !== next && !item.path.startsWith(`${next}/`));
  saveExternalSqlFileTargets([...moved, ...remaining].slice(0, MAX_EXTERNAL_SQL_FILE_TARGETS));
}

export function forgetExternalSqlFileTarget(path: string) {
  const normalizedPath = normalizeExternalSqlPath(path);
  if (!normalizedPath) return;
  saveExternalSqlFileTargets(loadExternalSqlFileTargets().filter((item) => item.path !== normalizedPath));
}

export function forgetExternalSqlFolderTargets(path: string) {
  const normalized = normalizeExternalSqlPath(path);
  if (!normalized) return;
  const prefix = `${normalized}/`;
  saveExternalSqlFileTargets(loadExternalSqlFileTargets().filter((item) => item.path !== normalized && !item.path.startsWith(prefix)));
}

export function resolveExternalSqlFileTarget(path: string, connectionExists: (connectionId: string) => boolean, fallback: ExternalSqlFileTarget): ExternalSqlFileTarget {
  const normalizedPath = normalizeExternalSqlPath(path);
  const saved = loadExternalSqlFileTargets().find((item) => item.path === normalizedPath);
  if (!saved || !connectionExists(saved.connectionId)) return fallback;
  return { connectionId: saved.connectionId, database: saved.database, catalog: saved.catalog, schema: saved.schema };
}

export function resolveExternalSqlFileTargetForActiveTab(path: string, tabs: readonly ExternalSqlFileTargetTab[], activeTabId: string | null | undefined, getConnection: ExternalSqlFileConnectionLookup, options: ExternalSqlFileTargetOptions = {}): ExternalSqlFileTarget {
  return resolveExternalSqlFileTarget(path, (connectionId) => !!getConnection(connectionId), activeTabExternalSqlFileTarget(tabs, activeTabId, getConnection, options));
}
