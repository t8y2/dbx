import type { QueryTab } from "@/types/database";

export const OPEN_TABS_STORAGE_KEY = "dbx-open-tabs";
export const ACTIVE_TAB_STORAGE_KEY = "dbx-active-tab";

export interface SavedQueryResultRun {
  id: string;
  title: string;
  sequence: number;
  sql: string;
  createdAt: number;
  activeResultIndex?: number;
  resultCacheKey?: string;
  resultEvicted?: boolean;
}

export interface SavedOpenTab {
  id: string;
  title: string;
  customTitle?: boolean;
  connectionId: string;
  database: string;
  schema?: string;
  sql: string;
  originalSql?: string;
  savedSqlId?: string;
  externalSqlPath?: string;
  lastExecutedSql?: string;
  resultBaseSql?: string;
  resultSortedSql?: string;
  resultSortColumn?: string;
  resultSortColumnIndex?: number;
  resultSortDirection?: QueryTab["resultSortDirection"];
  resultSortMode?: QueryTab["resultSortMode"];
  orderByInput?: string;
  resultPageLimit?: number;
  resultPageOffset?: number;
  whereInput?: string;
  pinned?: boolean;
  mode?: QueryTab["mode"];
  mqTenant?: string;
  mqInitialTab?: QueryTab["mqInitialTab"];
  nacosNamespace?: string;
  nacosNamespaceName?: string;
  structureTableName?: string;
  objectBrowser?: QueryTab["objectBrowser"];
  objectSource?: QueryTab["objectSource"];
  tableMeta?: QueryTab["tableMeta"];
  mongoEditTarget?: QueryTab["mongoEditTarget"];
  resultEvicted?: boolean;
  resultCacheKey?: string;
  resultRuns?: SavedQueryResultRun[];
  activeResultRunId?: string;
  resultAutoSave?: boolean;
}

export interface RestoredOpenTabs {
  tabs: QueryTab[];
  activeTabId: string | null;
}

export type OpenTabsRestoreFilter = "all" | "pinned";

function shouldPersistTabSql(tab: QueryTab) {
  if (!tab.savedSqlId) return true;
  return tab.originalSql !== undefined && tab.sql !== tab.originalSql;
}

function restoredOriginalSql(tab: SavedOpenTab, mode: QueryTab["mode"], sql: string) {
  if (mode !== "query") return undefined;
  if (tab.externalSqlPath) return sql;
  if (tab.savedSqlId) return sql ? "" : undefined;
  // Prefer the persisted originalSql so a clean prefilled query tab (sql === originalSql)
  // restores clean instead of being marked dirty. Older saved state without this field
  // falls through to "" (preserving prior behavior for user-edited scratch tabs).
  if (tab.originalSql !== undefined) return tab.originalSql;
  return "";
}

export function serializeOpenTabs(tabs: QueryTab[]): SavedOpenTab[] {
  return tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    ...(tab.customTitle ? { customTitle: true } : {}),
    connectionId: tab.connectionId,
    database: tab.database,
    schema: tab.schema,
    sql: shouldPersistTabSql(tab) ? tab.sql : "",
    // Only round-trip originalSql for plain query tabs (no savedSqlId / externalSqlPath):
    // saved-SQL and external-file tabs re-derive it on restore, and persisting it here
    // would duplicate their (potentially large) SQL text in the open-tabs state.
    ...(tab.originalSql !== undefined && !tab.savedSqlId && !tab.externalSqlPath ? { originalSql: tab.originalSql } : {}),
    savedSqlId: tab.savedSqlId,
    externalSqlPath: tab.externalSqlPath,
    ...(tab.lastExecutedSql !== undefined ? { lastExecutedSql: tab.lastExecutedSql } : {}),
    ...(tab.resultBaseSql !== undefined ? { resultBaseSql: tab.resultBaseSql } : {}),
    ...(tab.resultSortedSql !== undefined ? { resultSortedSql: tab.resultSortedSql } : {}),
    ...(tab.resultSortColumn !== undefined ? { resultSortColumn: tab.resultSortColumn } : {}),
    ...(tab.resultSortColumnIndex !== undefined ? { resultSortColumnIndex: tab.resultSortColumnIndex } : {}),
    ...(tab.resultSortDirection !== undefined ? { resultSortDirection: tab.resultSortDirection } : {}),
    ...(tab.resultSortMode !== undefined ? { resultSortMode: tab.resultSortMode } : {}),
    ...(tab.orderByInput !== undefined ? { orderByInput: tab.orderByInput } : {}),
    ...(tab.resultPageLimit !== undefined ? { resultPageLimit: tab.resultPageLimit } : {}),
    ...(tab.resultPageOffset !== undefined ? { resultPageOffset: tab.resultPageOffset } : {}),
    ...(tab.whereInput !== undefined ? { whereInput: tab.whereInput } : {}),
    pinned: tab.pinned,
    mode: tab.mode,
    ...(tab.mqTenant !== undefined ? { mqTenant: tab.mqTenant } : {}),
    ...(tab.mqInitialTab !== undefined ? { mqInitialTab: tab.mqInitialTab } : {}),
    ...(tab.nacosNamespace !== undefined ? { nacosNamespace: tab.nacosNamespace } : {}),
    ...(tab.nacosNamespaceName !== undefined ? { nacosNamespaceName: tab.nacosNamespaceName } : {}),
    ...(tab.structureTableName !== undefined ? { structureTableName: tab.structureTableName } : {}),
    objectBrowser: tab.objectBrowser,
    objectSource: tab.objectSource,
    tableMeta: tab.tableMeta,
    ...(tab.mongoEditTarget !== undefined ? { mongoEditTarget: tab.mongoEditTarget } : {}),
    ...(tab.mode !== "data" && tab.resultEvicted ? { resultEvicted: true } : {}),
    ...(tab.mode !== "data" && tab.resultEvicted && tab.resultCacheKey !== undefined ? { resultCacheKey: tab.resultCacheKey } : {}),
    ...(tab.mode === "query" && tab.resultRuns?.length
      ? {
          resultRuns: tab.resultRuns.map((run) => ({
            id: run.id,
            title: run.title,
            sequence: run.sequence,
            sql: run.sql,
            createdAt: run.createdAt,
            activeResultIndex: run.activeResultIndex,
            ...(run.resultCacheKey !== undefined ? { resultCacheKey: run.resultCacheKey } : {}),
            ...(run.resultEvicted ? { resultEvicted: true } : {}),
          })),
        }
      : {}),
    ...(tab.mode === "query" && tab.activeResultRunId !== undefined ? { activeResultRunId: tab.activeResultRunId } : {}),
    ...(tab.mode === "query" && tab.resultAutoSave ? { resultAutoSave: true } : {}),
  }));
}

function isSavedOpenTab(value: unknown): value is SavedOpenTab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Record<string, unknown>;
  return typeof tab.id === "string" && typeof tab.title === "string" && typeof tab.connectionId === "string" && typeof tab.database === "string" && (typeof tab.sql === "string" || typeof tab.savedSqlId === "string");
}

function restoreOpenTabsArray(parsed: unknown, rawActiveTabId: string | null, options: { queryOnly?: boolean; filter?: OpenTabsRestoreFilter } = {}): RestoredOpenTabs {
  if (!Array.isArray(parsed)) return { tabs: [], activeTabId: null };

  try {
    const saved = parsed.filter(isSavedOpenTab);
    const filtered = saved.filter((tab) => {
      if (options.queryOnly && (tab.mode ?? "query") !== "query") return false;
      if (options.filter === "pinned" && !tab.pinned) return false;
      return true;
    });
    const tabs: QueryTab[] = filtered.map((tab) => {
      const mode = tab.mode ?? "query";
      const resultRuns =
        mode === "query"
          ? tab.resultRuns?.map((run) => ({
              ...run,
              result: undefined,
              results: undefined,
              resultCacheState: run.resultCacheKey ? ("disk" as const) : undefined,
            }))
          : undefined;
      return {
        ...tab,
        mode,
        sql: typeof tab.sql === "string" ? tab.sql : "",
        isExecuting: false,
        isCancelling: false,
        queryExecutionStartedAt: undefined,
        editorViewport: undefined,
        editorSelection: undefined,
        isExplaining: false,
        originalSql: restoredOriginalSql(tab, mode, typeof tab.sql === "string" ? tab.sql : ""),
        resultEvicted: mode === "data" ? undefined : tab.resultEvicted,
        resultCacheKey: mode === "data" ? undefined : tab.resultCacheKey,
        resultCacheState: mode !== "data" && tab.resultCacheKey ? "disk" : undefined,
        resultRuns,
        activeResultRunId: resultRuns?.some((run) => run.id === tab.activeResultRunId) ? tab.activeResultRunId : resultRuns?.[0]?.id,
        resultAutoSave: mode === "query" && tab.resultAutoSave ? true : undefined,
      };
    });
    const activeTabId = rawActiveTabId || null;

    return {
      tabs,
      activeTabId: tabs.some((tab) => tab.id === activeTabId) ? activeTabId : tabs[0]?.id || null,
    };
  } catch {
    return { tabs: [], activeTabId: null };
  }
}

export function restoreOpenTabsPayload(payload: { tabs?: unknown; activeTabId?: unknown } | null | undefined, options: { queryOnly?: boolean; filter?: OpenTabsRestoreFilter } = {}): RestoredOpenTabs {
  if (!payload) return { tabs: [], activeTabId: null };
  return restoreOpenTabsArray(payload.tabs, typeof payload.activeTabId === "string" ? payload.activeTabId : null, options);
}

export function restoreOpenTabsState(rawTabs: string | null, rawActiveTabId: string | null, options: { queryOnly?: boolean; filter?: OpenTabsRestoreFilter } = {}): RestoredOpenTabs {
  if (!rawTabs) return { tabs: [], activeTabId: null };

  try {
    return restoreOpenTabsArray(JSON.parse(rawTabs), rawActiveTabId, options);
  } catch {
    return { tabs: [], activeTabId: null };
  }
}
