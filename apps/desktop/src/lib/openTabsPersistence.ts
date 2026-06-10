import type { QueryTab } from "@/types/database";

export interface SavedOpenTab {
  id: string;
  title: string;
  customTitle?: boolean;
  connectionId: string;
  database: string;
  schema?: string;
  sql: string;
  savedSqlId?: string;
  lastExecutedSql?: string;
  resultBaseSql?: string;
  resultSortedSql?: string;
  resultSortColumn?: string;
  resultSortColumnIndex?: number;
  resultSortDirection?: QueryTab["resultSortDirection"];
  orderByInput?: string;
  resultPageLimit?: number;
  resultPageOffset?: number;
  whereInput?: string;
  pinned?: boolean;
  mode?: QueryTab["mode"];
  structureTableName?: string;
  objectBrowser?: QueryTab["objectBrowser"];
  objectSource?: QueryTab["objectSource"];
  tableMeta?: QueryTab["tableMeta"];
  resultEvicted?: boolean;
  resultCacheKey?: string;
}

export interface RestoredOpenTabs {
  tabs: QueryTab[];
  activeTabId: string | null;
}

export function serializeOpenTabs(tabs: QueryTab[]): SavedOpenTab[] {
  return tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    ...(tab.customTitle ? { customTitle: true } : {}),
    connectionId: tab.connectionId,
    database: tab.database,
    schema: tab.schema,
    sql: tab.sql,
    savedSqlId: tab.savedSqlId,
    ...(tab.lastExecutedSql !== undefined ? { lastExecutedSql: tab.lastExecutedSql } : {}),
    ...(tab.resultBaseSql !== undefined ? { resultBaseSql: tab.resultBaseSql } : {}),
    ...(tab.resultSortedSql !== undefined ? { resultSortedSql: tab.resultSortedSql } : {}),
    ...(tab.resultSortColumn !== undefined ? { resultSortColumn: tab.resultSortColumn } : {}),
    ...(tab.resultSortColumnIndex !== undefined ? { resultSortColumnIndex: tab.resultSortColumnIndex } : {}),
    ...(tab.resultSortDirection !== undefined ? { resultSortDirection: tab.resultSortDirection } : {}),
    ...(tab.orderByInput !== undefined ? { orderByInput: tab.orderByInput } : {}),
    ...(tab.resultPageLimit !== undefined ? { resultPageLimit: tab.resultPageLimit } : {}),
    ...(tab.resultPageOffset !== undefined ? { resultPageOffset: tab.resultPageOffset } : {}),
    ...(tab.whereInput !== undefined ? { whereInput: tab.whereInput } : {}),
    pinned: tab.pinned,
    mode: tab.mode,
    ...(tab.structureTableName !== undefined ? { structureTableName: tab.structureTableName } : {}),
    objectBrowser: tab.objectBrowser,
    objectSource: tab.objectSource,
    tableMeta: tab.tableMeta,
    ...(tab.mode !== "data" && tab.resultEvicted ? { resultEvicted: true } : {}),
    ...(tab.mode !== "data" && tab.resultEvicted && tab.resultCacheKey !== undefined ? { resultCacheKey: tab.resultCacheKey } : {}),
  }));
}

function isSavedOpenTab(value: unknown): value is SavedOpenTab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Record<string, unknown>;
  return typeof tab.id === "string" && typeof tab.title === "string" && typeof tab.connectionId === "string" && typeof tab.database === "string" && typeof tab.sql === "string";
}

export function restoreOpenTabsState(rawTabs: string | null, rawActiveTabId: string | null, options: { queryOnly?: boolean } = {}): RestoredOpenTabs {
  if (!rawTabs) return { tabs: [], activeTabId: null };

  try {
    const parsed = JSON.parse(rawTabs);
    if (!Array.isArray(parsed)) return { tabs: [], activeTabId: null };

    const saved = parsed.filter(isSavedOpenTab);
    const filtered = options.queryOnly ? saved.filter((tab) => (tab.mode ?? "query") === "query") : saved;
    const tabs: QueryTab[] = filtered.map((tab) => {
      const mode = tab.mode ?? "query";
      return {
        ...tab,
        mode,
        isExecuting: false,
        isCancelling: false,
        queryExecutionStartedAt: undefined,
        editorViewport: undefined,
        editorSelection: undefined,
        isExplaining: false,
        resultEvicted: mode === "data" ? undefined : tab.resultEvicted,
        resultCacheKey: mode === "data" ? undefined : tab.resultCacheKey,
        resultCacheState: mode !== "data" && tab.resultCacheKey ? "disk" : undefined,
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
