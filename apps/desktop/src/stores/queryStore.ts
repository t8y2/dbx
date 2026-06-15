import { defineStore } from "pinia";
import { uuid } from "@/lib/utils";
import { markRaw, ref, watch, computed } from "vue";
import { useI18n } from "vue-i18n";
import type { DatabaseType, QueryResult, QueryTab } from "@/types/database";
import { orderPinnedFirst } from "@/lib/pinnedItems";
import { canCancelQueryExecution } from "@/lib/queryExecutionState";
import { closeAllTabsState, closeOtherTabsState } from "@/lib/tabCloseActions";
import { buildExplainSql, parseExplainResult, parseDamengExplainText } from "@/lib/explainPlan";
import { allEditableColumnsWriteable, allPrimaryKeysPresent, sourceColumnsForResult, type EditableQueryInfo } from "@/lib/sqlAnalysis";
import { restoreOpenTabsState, serializeOpenTabs } from "@/lib/openTabsPersistence";
import {
  evaluateMongoAggregateSafety,
  mongoCountToQueryResult,
  mongoDocumentsToQueryResult,
  mongoIndexesToQueryResult,
  mongoWriteToQueryResult,
  parseMongoAggregateCommand,
  parseMongoCountDocumentsCommand,
  parseMongoFindCommand,
  parseMongoGetIndexesCommand,
  parseMongoWriteCommand,
  type MongoAggregateSafetyOptions,
} from "@/lib/mongoShellCommand";
import { redisCommandResultToQueryResult } from "@/lib/redisQueryResult";
import { nextRedisCommandDb } from "@/lib/redisCommandSession";
import { supportsDatabaseFeature } from "@/lib/databaseCapabilities";
import { editablePrimaryKeys } from "@/lib/tableEditing";
import { TABLE_DATA_EXPORT_PAGE_SIZE } from "@/lib/tableDataExport";
import { tableMetaForDataTab } from "@/lib/tableDataTabMeta";
import { quoteTableIdentifier } from "@/lib/tableSelectSql";
import { connectionUsesDatabaseObjectTreeMode, connectionUsesSchemaExecutionContext, effectiveDatabaseTypeForConnection } from "@/lib/jdbcDialect";
import { queryTimeoutSecsForConnection } from "@/lib/queryTimeout";
import { clearDataGridPendingSnapshotsForTab } from "@/composables/useDataGridEditor";
import { buildTabResultSnapshot, deleteTabResultSnapshot, readTabResultSnapshot, tabResultCacheKey, writeTabResultSnapshot } from "@/lib/tabResultCache";
import { decodeQueryResultArchive, encodeQueryResultArchive, type DecodedQueryResultArchive } from "@/lib/queryResultArchive";
import * as api from "@/lib/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { SavedSqlFile } from "@/types/database";

const STORAGE_KEY = "dbx-open-tabs";
const ACTIVE_TAB_KEY = "dbx-active-tab";
const ORACLE_LIKE_METADATA_TYPES = new Set<string>(["oracle", "dameng", "oceanbase-oracle"]);

function markQueryResultRowsRaw(result: QueryResult): QueryResult {
  markRaw(result.rows);
  return result;
}

function markQueryResultsRowsRaw(results: QueryResult[]): QueryResult[] {
  for (const result of results) markQueryResultRowsRaw(result);
  return results;
}

function markQueryResultRunsRowsRaw(resultRuns: NonNullable<QueryTab["resultRuns"]>): NonNullable<QueryTab["resultRuns"]> {
  for (const run of resultRuns) {
    if (run.result) markQueryResultRowsRaw(run.result);
    if (run.results) markQueryResultsRowsRaw(run.results);
  }
  return resultRuns;
}

async function withFrontendQueryTimeout<T>(promise: Promise<T>, timeoutSecs: number, message: string): Promise<T> {
  if (timeoutSecs === 0) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutSecs * 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeOracleLikeMetadataIdentifier(dbType: string, identifier: string | undefined, quoted?: boolean) {
  if (!identifier || quoted || !ORACLE_LIKE_METADATA_TYPES.has(dbType)) return identifier;
  return identifier.toUpperCase();
}

function normalizeOracleLikeQueryAnalysis(dbType: string, analysis: EditableQueryInfo, schema: string | undefined, tableName: string): EditableQueryInfo {
  if (!ORACLE_LIKE_METADATA_TYPES.has(dbType)) return analysis;
  return {
    ...analysis,
    schema,
    tableName,
    columns: analysis.columns.map((column) => ({
      ...column,
      sourceName: normalizeOracleLikeMetadataIdentifier(dbType, column.sourceName, column.sourceNameQuoted),
    })),
  };
}

function saveTabs(tabs: QueryTab[], activeTabId: string | null) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeOpenTabs(tabs)));
    localStorage.setItem(ACTIVE_TAB_KEY, activeTabId || "");
  } catch {}
}

function loadSavedTabs(): { tabs: QueryTab[]; activeTabId: string | null } {
  try {
    return restoreOpenTabsState(localStorage.getItem(STORAGE_KEY), localStorage.getItem(ACTIVE_TAB_KEY));
  } catch {
    return { tabs: [], activeTabId: null };
  }
}

function getI18nT() {
  try {
    return useI18n().t;
  } catch {
    return ((key: string, ..._args: unknown[]) => key) as ReturnType<typeof useI18n>["t"];
  }
}

export const useQueryStore = defineStore("query", () => {
  const t = getI18nT();
  const restored = loadSavedTabs();
  const tabs = ref<QueryTab[]>(restored.tabs);
  const activeTabId = ref<string | null>(restored.activeTabId);
  const showCloseConfirm = ref(false);
  const pendingCloseTabId = ref<string | null>(null);
  for (const tab of restored.tabs) {
    if (tab.mode === "data") void deleteTabResultSnapshot(tabResultCacheKey(tab.id));
  }
  const tableStructureRefreshVersions = ref<Record<string, number>>({});

  function tableStructureKey(connectionId: string, database: string, schema: string | undefined, tableName: string): string {
    return [connectionId, database, schema || "", tableName].map((part) => part.toLowerCase()).join("\u0000");
  }

  function invalidateTableStructure(connectionId: string, database: string, schema: string | undefined, tableName: string) {
    if (!tableName) return;
    const key = tableStructureKey(connectionId, database, schema, tableName);
    tableStructureRefreshVersions.value = {
      ...tableStructureRefreshVersions.value,
      [key]: (tableStructureRefreshVersions.value[key] ?? 0) + 1,
    };
  }

  function tableStructureRefreshVersion(connectionId: string, database: string, schema: string | undefined, tableName: string): number {
    return tableStructureRefreshVersions.value[tableStructureKey(connectionId, database, schema, tableName)] ?? 0;
  }
  const MAX_CACHED_RESULTS = 5;

  async function closeResultSession(tab: QueryTab | undefined, preserveSessionId?: string) {
    const sessionId = tab?.resultSessionId ?? tab?.result?.session_id;
    if (!tab || !sessionId || sessionId === preserveSessionId) return;
    try {
      await api.closeQuerySession(tab.connectionId, tab.database, sessionId, tab.id);
    } catch (error) {
      console.warn("[DBX][query-session:close:error]", { tabId: tab.id, sessionId, error });
    } finally {
      if (tab.resultSessionId === sessionId) tab.resultSessionId = undefined;
      if (tab.result?.session_id === sessionId) tab.result.session_id = undefined;
    }
  }

  async function closeClientConnectionSession(tab: QueryTab | undefined) {
    if (!tab?.connectionId) return;
    try {
      await api.closeClientConnectionSession(tab.connectionId, tab.database, tab.id);
    } catch (error) {
      console.warn("[DBX][client-session:close:error]", { tabId: tab.id, error });
    }
  }

  function touchResult(tab: QueryTab | undefined, accessedAt = Date.now()) {
    if (tab?.result || tab?.results) {
      tab.resultAccessedAt = accessedAt;
      tab.resultCacheState = "memory";
      tab.resultEvicted = undefined;
    }
  }

  function clearResultPayload(tab: QueryTab, options: { evicted?: boolean } = {}) {
    tab.result = undefined;
    tab.results = undefined;
    tab.activeResultIndex = undefined;
    tab.resultSessionId = undefined;
    tab.resultAccessedAt = undefined;
    tab.queryAnalysis = undefined;
    tab.querySourceColumns = undefined;
    tab.queryEditabilityReason = undefined;
    if (tab.mode === "query") tab.tableMeta = undefined;
    tab.resultEvicted = options.evicted ? true : undefined;
    tab.resultCacheState = options.evicted ? tab.resultCacheState : undefined;
    if (!options.evicted) {
      if (tab.resultCacheKey) void deleteTabResultSnapshot(tab.resultCacheKey);
      tab.resultCacheKey = undefined;
    }
  }

  function projectResultRun(tab: QueryTab, run: NonNullable<QueryTab["resultRuns"]>[number]) {
    const activeIndex = run.activeResultIndex ?? 0;
    tab.activeResultRunId = run.id;
    tab.result = run.result ?? run.results?.[activeIndex];
    tab.results = run.results;
    tab.activeResultIndex = run.activeResultIndex;
    tab.resultBaseSql = run.resultBaseSql;
    tab.resultSortedSql = run.resultSortedSql;
    tab.resultSortColumn = run.resultSortColumn;
    tab.resultSortColumnIndex = run.resultSortColumnIndex;
    tab.resultSortDirection = run.resultSortDirection;
    tab.orderByInput = run.orderByInput;
    tab.resultPageSql = run.resultPageSql;
    tab.resultPageLimit = run.resultPageLimit;
    tab.resultPageOffset = run.resultPageOffset;
    tab.resultCountSql = run.resultCountSql;
    tab.resultTotalRowCount = run.resultTotalRowCount;
    tab.resultTotalRowCountLoading = run.resultTotalRowCountLoading;
    tab.resultSessionId = run.resultSessionId;
    tab.resultAccessedAt = run.resultAccessedAt;
    tab.resultCacheKey = run.resultCacheKey;
    tab.resultCacheState = run.resultCacheState;
    tab.resultEvicted = run.resultEvicted;
    tab.queryAnalysis = run.queryAnalysis;
    tab.querySourceColumns = run.querySourceColumns;
    tab.queryEditabilityReason = run.queryEditabilityReason;
    tab.tableMeta = run.tableMeta;
    touchResult(tab);
  }

  function setActiveResultRun(id: string, runId: string) {
    const tab = tabs.value.find((t) => t.id === id);
    const run = tab?.resultRuns?.find((item) => item.id === runId);
    if (!tab || !run) return false;
    projectResultRun(tab, run);
    return true;
  }

  function removeResultRun(id: string, runId: string) {
    const tab = tabs.value.find((t) => t.id === id);
    const runIndex = tab?.resultRuns?.findIndex((run) => run.id === runId) ?? -1;
    if (!tab || !tab.resultRuns || runIndex < 0) return false;

    const wasActive = tab.activeResultRunId === runId;
    const remainingRuns = tab.resultRuns.filter((run) => run.id !== runId);
    tab.resultRuns = remainingRuns;

    if (!wasActive) return true;

    const nextRun = remainingRuns[Math.min(runIndex, remainingRuns.length - 1)];
    if (nextRun) {
      projectResultRun(tab, nextRun);
      return true;
    }

    tab.activeResultRunId = undefined;
    clearResultPayload(tab);
    return true;
  }

  function nextResultRunSequence(tab: QueryTab): number {
    return (tab.resultRuns?.reduce((max, run) => Math.max(max, run.sequence), 0) ?? 0) + 1;
  }

  function captureDisplayedResultRun(tab: QueryTab, sql: string, createdAt = Date.now()) {
    if (tab.mode !== "query" || !tab.result) return;
    const sequence = nextResultRunSequence(tab);
    const run: NonNullable<QueryTab["resultRuns"]>[number] = {
      id: uuid(),
      title: `Run ${sequence}`,
      sequence,
      sql,
      createdAt,
      result: tab.result,
      results: tab.results,
      activeResultIndex: tab.activeResultIndex,
      resultBaseSql: tab.resultBaseSql,
      resultSortedSql: tab.resultSortedSql,
      resultSortColumn: tab.resultSortColumn,
      resultSortColumnIndex: tab.resultSortColumnIndex,
      resultSortDirection: tab.resultSortDirection,
      orderByInput: tab.orderByInput,
      resultPageSql: tab.resultPageSql,
      resultPageLimit: tab.resultPageLimit,
      resultPageOffset: tab.resultPageOffset,
      resultCountSql: tab.resultCountSql,
      resultTotalRowCount: tab.resultTotalRowCount,
      resultTotalRowCountLoading: tab.resultTotalRowCountLoading,
      resultSessionId: tab.resultSessionId,
      resultAccessedAt: tab.resultAccessedAt,
      resultCacheKey: tab.resultCacheKey,
      resultCacheState: tab.resultCacheState,
      resultEvicted: tab.resultEvicted,
      queryAnalysis: tab.queryAnalysis,
      querySourceColumns: tab.querySourceColumns,
      queryEditabilityReason: tab.queryEditabilityReason,
      tableMeta: tab.tableMeta,
    };
    tab.resultRuns = [...(tab.resultRuns ?? []), run];
    tab.activeResultRunId = run.id;
  }

  function syncActiveResultRunFromDisplayed(tab: QueryTab) {
    if (!tab.activeResultRunId || !tab.resultRuns?.length) return;
    const index = tab.resultRuns.findIndex((run) => run.id === tab.activeResultRunId);
    if (index < 0) return;
    tab.resultRuns[index] = {
      ...tab.resultRuns[index],
      result: tab.result,
      results: tab.results,
      activeResultIndex: tab.activeResultIndex,
      resultBaseSql: tab.resultBaseSql,
      resultSortedSql: tab.resultSortedSql,
      resultSortColumn: tab.resultSortColumn,
      resultSortColumnIndex: tab.resultSortColumnIndex,
      resultSortDirection: tab.resultSortDirection,
      orderByInput: tab.orderByInput,
      resultPageSql: tab.resultPageSql,
      resultPageLimit: tab.resultPageLimit,
      resultPageOffset: tab.resultPageOffset,
      resultCountSql: tab.resultCountSql,
      resultTotalRowCount: tab.resultTotalRowCount,
      resultTotalRowCountLoading: tab.resultTotalRowCountLoading,
      resultSessionId: tab.resultSessionId,
      resultAccessedAt: tab.resultAccessedAt,
      resultCacheKey: tab.resultCacheKey,
      resultCacheState: tab.resultCacheState,
      resultEvicted: tab.resultEvicted,
      queryAnalysis: tab.queryAnalysis,
      querySourceColumns: tab.querySourceColumns,
      queryEditabilityReason: tab.queryEditabilityReason,
      tableMeta: tab.tableMeta,
    };
  }

  function resultRunHasPayload(run: NonNullable<QueryTab["resultRuns"]>[number]): boolean {
    return !!run.result || !!run.results?.length;
  }

  function resultSnapshotHasPayload(snapshot: NonNullable<ReturnType<typeof buildTabResultSnapshot>>): boolean {
    return !!snapshot.result || !!snapshot.results?.length || !!snapshot.resultRuns?.some(resultRunHasPayload);
  }

  async function evictCachedResult(tab: QueryTab) {
    await closeResultSession(tab);
    const cacheKey = tabResultCacheKey(tab.id);
    const cached = await writeTabResultSnapshot(cacheKey, buildTabResultSnapshot(tab));
    tab.resultCacheKey = cached ? cacheKey : undefined;
    tab.resultCacheState = cached ? "disk" : "missing";
    clearResultPayload(tab, { evicted: true });
  }

  const _persistSnapshot = computed(() =>
    tabs.value.map((t) => ({
      id: t.id,
      title: t.title,
      connectionId: t.connectionId,
      database: t.database,
      schema: t.schema,
      sql: t.sql,
      savedSqlId: t.savedSqlId,
      lastExecutedSql: t.lastExecutedSql,
      resultBaseSql: t.resultBaseSql,
      resultSortedSql: t.resultSortedSql,
      resultSortColumn: t.resultSortColumn,
      resultSortColumnIndex: t.resultSortColumnIndex,
      resultSortDirection: t.resultSortDirection,
      orderByInput: t.orderByInput,
      resultPageLimit: t.resultPageLimit,
      resultPageOffset: t.resultPageOffset,
      whereInput: t.whereInput,
      pinned: t.pinned,
      mode: t.mode,
      structureTableName: t.structureTableName,
      objectBrowser: t.objectBrowser,
      objectSource: t.objectSource,
      tableMeta: t.tableMeta,
      resultEvicted: t.resultEvicted,
      resultCacheKey: t.resultCacheKey,
    })),
  );

  let _persistTimer: ReturnType<typeof setTimeout> | null = null;
  watch(
    [_persistSnapshot, activeTabId],
    () => {
      if (_persistTimer) clearTimeout(_persistTimer);
      _persistTimer = setTimeout(() => {
        saveTabs(tabs.value, activeTabId.value);
        _persistTimer = null;
      }, 300);
    },
    { flush: "post" },
  );

  function findTabByIdentity(connectionId: string, database: string, title: string, mode: QueryTab["mode"], schema?: string) {
    return tabs.value.find((tab) => tab.connectionId === connectionId && tab.database === database && tab.title === title && tab.mode === mode && (tab.schema || "") === (schema || ""));
  }

  function createTab(connectionId: string, database: string, title?: string, mode: QueryTab["mode"] = "query", schema?: string) {
    if (title) {
      const existing = findTabByIdentity(connectionId, database, title, mode, schema);
      if (existing) {
        activeTabId.value = existing.id;
        return existing.id;
      }
    }

    const id = uuid();
    const tab: QueryTab = {
      id,
      title: title || `query_${tabs.value.length + 1}`,
      customTitle: mode === "query" && !!title ? true : undefined,
      connectionId,
      database,
      schema,
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode,
    };
    if (mode === "query") tab.originalSql = "";
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function openObjectBrowser(connectionId: string, database: string, schema?: string) {
    const title = schema ? `${schema} objects` : `${database} objects`;
    const existing = tabs.value.find((tab) => tab.mode === "objects" && tab.connectionId === connectionId && tab.database === database && (tab.objectBrowser?.schema || "") === (schema || ""));
    if (existing) {
      activeTabId.value = existing.id;
      return existing.id;
    }

    const id = uuid();
    const tab: QueryTab = {
      id,
      title,
      connectionId,
      database,
      schema,
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "objects",
      objectBrowser: {
        schema,
        objectType: "tables",
      },
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function openUserAdmin(connectionId: string) {
    const existing = tabs.value.find((tab) => tab.mode === "users" && tab.connectionId === connectionId);
    if (existing) {
      activeTabId.value = existing.id;
      return existing.id;
    }

    const conn = useConnectionStore().getConfig(connectionId);
    const id = uuid();
    const tab: QueryTab = {
      id,
      title: t("userAdmin.title"),
      connectionId,
      database: conn?.database || "",
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "users",
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function openTableStructure(connectionId: string, database: string, schema?: string, tableName?: string) {
    const resolvedTableName = tableName || "";
    if (resolvedTableName) {
      const existing = tabs.value.find((tab) => tab.mode === "structure" && tab.connectionId === connectionId && tab.database === database && (tab.structureTableName || "") === resolvedTableName);
      if (existing) {
        activeTabId.value = existing.id;
        return existing.id;
      }
    }

    const title = resolvedTableName ? t("structureEditor.editTabTitle", { tableName: resolvedTableName }) : t("structureEditor.createTitle");
    const id = uuid();
    const tab: QueryTab = {
      id,
      title,
      connectionId,
      database,
      schema,
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "structure",
      structureTableName: resolvedTableName,
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function isTabDirty(tab: QueryTab): boolean {
    if (tab.mode !== "query") return false;
    if (!tab.sql.trim()) return false;
    const original = tab.originalSql;
    if (original === undefined) return !!tab.savedSqlId;
    return tab.sql !== original;
  }

  function markTabClean(tab: QueryTab | undefined) {
    if (tab) tab.originalSql = tab.sql;
  }

  function closeTab(id: string, { force = false }: { force?: boolean } = {}) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    if (!force && isTabDirty(tab)) {
      pendingCloseTabId.value = id;
      showCloseConfirm.value = true;
      return;
    }
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx < 0) return;
    clearDataGridPendingSnapshotsForTab(id);
    if (tabs.value[idx].isExecuting) void cancelTabExecution(id);
    if (tabs.value[idx].isExplaining) void cancelTabExplain(id);
    void closeResultSession(tabs.value[idx]);
    void closeClientConnectionSession(tabs.value[idx]);
    clearResultPayload(tabs.value[idx]);
    tabs.value.splice(idx, 1);
    if (activeTabId.value === id) {
      activeTabId.value = tabs.value[Math.min(idx, tabs.value.length - 1)]?.id ?? null;
    }
  }

  function forceClosePendingTab() {
    const id = pendingCloseTabId.value;
    pendingCloseTabId.value = null;
    showCloseConfirm.value = false;
    if (id) closeTab(id, { force: true });
  }

  function cancelClosePendingTab() {
    pendingCloseTabId.value = null;
    showCloseConfirm.value = false;
  }

  function saveAndClosePendingTab() {
    const id = pendingCloseTabId.value;
    pendingCloseTabId.value = null;
    showCloseConfirm.value = false;
    if (id) return id;
    return null;
  }

  function closeOtherTabs(id: string) {
    tabs.value
      .filter((tab) => tab.id !== id)
      .forEach((tab) => {
        clearDataGridPendingSnapshotsForTab(tab.id);
        if (tab.isExecuting) void cancelTabExecution(tab.id);
        if (tab.isExplaining) void cancelTabExplain(tab.id);
        void closeResultSession(tab);
        void closeClientConnectionSession(tab);
        clearResultPayload(tab);
      });
    const next = closeOtherTabsState(tabs.value, activeTabId.value, id);
    tabs.value = next.tabs;
    activeTabId.value = next.activeTabId;
  }

  function closeAllTabs() {
    tabs.value.forEach((tab) => {
      clearDataGridPendingSnapshotsForTab(tab.id);
      if (tab.isExecuting) void cancelTabExecution(tab.id);
      if (tab.isExplaining) void cancelTabExplain(tab.id);
      void closeResultSession(tab);
      void closeClientConnectionSession(tab);
      clearResultPayload(tab);
    });
    const next = closeAllTabsState(tabs.value, activeTabId.value);
    tabs.value = next.tabs;
    activeTabId.value = next.activeTabId;
  }

  function duplicateTab(id: string) {
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const original = tabs.value[idx];
    const newId = uuid();
    const newTab: QueryTab = {
      id: newId,
      title: original.title,
      customTitle: original.customTitle,
      connectionId: original.connectionId,
      database: original.database,
      schema: original.schema,
      sql: original.sql,
      savedSqlId: original.savedSqlId,
      lastExecutedSql: undefined,
      resultBaseSql: original.resultBaseSql,
      resultSortedSql: undefined,
      resultSortColumn: undefined,
      resultSortColumnIndex: undefined,
      resultSortDirection: undefined,
      orderByInput: undefined,
      resultPageSql: undefined,
      resultPageLimit: undefined,
      resultPageOffset: undefined,
      resultCountSql: undefined,
      resultTotalRowCount: undefined,
      resultTotalRowCountLoading: undefined,
      resultSessionId: undefined,
      resultAccessedAt: undefined,
      resultCacheKey: undefined,
      resultCacheState: undefined,
      pinned: false,
      result: undefined,
      results: undefined,
      activeResultIndex: undefined,
      explainPlan: undefined,
      explainError: undefined,
      explainSql: undefined,
      lastExplainedSql: undefined,
      isExecuting: false,
      isCancelling: false,
      queryExecutionStartedAt: undefined,
      editorViewport: undefined,
      editorSelection: undefined,
      executionId: undefined,
      isExplaining: false,
      explainExecutionId: undefined,
      mode: original.mode,
      structureTableName: original.structureTableName,
      objectBrowser: original.objectBrowser ? { ...original.objectBrowser } : undefined,
      objectSource: original.objectSource ? { ...original.objectSource } : undefined,
      tableMeta: original.tableMeta ? { ...original.tableMeta, columns: [...original.tableMeta.columns], primaryKeys: [...original.tableMeta.primaryKeys] } : undefined,
      queryAnalysis: original.queryAnalysis ? { ...original.queryAnalysis, columns: original.queryAnalysis.columns.map((c) => ({ ...c })) } : undefined,
      querySourceColumns: original.querySourceColumns ? [...original.querySourceColumns] : undefined,
      queryEditabilityReason: original.queryEditabilityReason,
      resultEvicted: undefined,
      whereInput: original.whereInput,
      previewSql: original.previewSql,
    };
    tabs.value.splice(idx + 1, 0, newTab);
    activeTabId.value = newId;
  }

  function closeTabsWhere(predicate: (tab: QueryTab) => boolean) {
    const closingIds = new Set(tabs.value.filter((tab) => predicate(tab)).map((tab) => tab.id));
    if (closingIds.size === 0) return;

    tabs.value
      .filter((tab) => closingIds.has(tab.id))
      .forEach((tab) => {
        clearDataGridPendingSnapshotsForTab(tab.id);
        if (tab.isExecuting) void cancelTabExecution(tab.id);
        if (tab.isExplaining) void cancelTabExplain(tab.id);
        void closeResultSession(tab);
        void closeClientConnectionSession(tab);
        clearResultPayload(tab);
      });

    const activeClosingIndex = tabs.value.findIndex((tab) => tab.id === activeTabId.value && closingIds.has(tab.id));
    tabs.value = tabs.value.filter((tab) => !closingIds.has(tab.id));
    if (activeClosingIndex >= 0) {
      activeTabId.value = tabs.value[Math.min(activeClosingIndex, tabs.value.length - 1)]?.id ?? null;
    }
  }

  function closeConnectionTabs(connectionId: string) {
    closeTabsWhere((tab) => tab.connectionId === connectionId);
  }

  function closeDatabaseTabs(connectionId: string, database: string) {
    closeTabsWhere((tab) => tab.connectionId === connectionId && tab.database === database);
  }

  function releaseTabsWhere(predicate: (tab: QueryTab) => boolean) {
    closeTabsWhere((tab) => predicate(tab) && tab.mode !== "query");
    tabs.value
      .filter((tab) => predicate(tab))
      .forEach((tab) => {
        if (tab.isExecuting) void cancelTabExecution(tab.id);
        if (tab.isExplaining) void cancelTabExplain(tab.id);
        void closeResultSession(tab);
        void closeClientConnectionSession(tab);
        clearResultPayload(tab);
      });
  }

  function releaseConnectionTabs(connectionId: string) {
    releaseTabsWhere((tab) => tab.connectionId === connectionId);
  }

  function releaseDatabaseTabs(connectionId: string, database: string) {
    releaseTabsWhere((tab) => tab.connectionId === connectionId && tab.database === database);
  }

  function updateSql(id: string, sql: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (tab) {
      tab.sql = sql;
    }
  }

  function updateEditorViewport(id: string, viewport: { scrollTop: number; scrollLeft: number }) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    tab.editorViewport = viewport;
  }

  function updateEditorSelection(id: string, selection: { anchor: number; head: number }) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    tab.editorSelection = selection;
  }

  function renameTab(id: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return false;
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || tab.mode !== "query") return false;
    tab.title = trimmed;
    tab.customTitle = true;
    return true;
  }

  function linkSavedSql(id: string, savedSqlId: string, title?: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    tab.savedSqlId = savedSqlId;
    if (title) {
      tab.title = title;
      tab.customTitle = true;
    }
  }

  function openSavedSql(file: SavedSqlFile) {
    const existing = tabs.value.find((tab) => tab.savedSqlId === file.id);
    if (existing) {
      activeTabId.value = existing.id;
      return existing.id;
    }

    const id = uuid();
    const tab: QueryTab = {
      id,
      title: file.name,
      customTitle: true,
      connectionId: file.connectionId,
      database: file.database,
      schema: file.schema,
      sql: file.sql,
      savedSqlId: file.id,
      originalSql: file.sql,
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "query",
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function togglePinnedTab(id: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    tab.pinned = !tab.pinned;
    tabs.value = orderPinnedFirst(tabs.value, (item) => !!item.pinned);
  }

  function reorderTab(id: string, targetId: string, position: "before" | "after") {
    const fromIdx = tabs.value.findIndex((t) => t.id === id);
    const toIdx = tabs.value.findIndex((t) => t.id === targetId);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    const [tab] = tabs.value.splice(fromIdx, 1);
    const newToIdx = tabs.value.findIndex((t) => t.id === targetId);
    tabs.value.splice(newToIdx + (position === "after" ? 1 : 0), 0, tab);
    tabs.value = orderPinnedFirst(tabs.value, (item) => !!item.pinned);
  }

  function updateDatabase(id: string, database: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || tab.database === database) return;
    void closeResultSession(tab);
    void closeClientConnectionSession(tab);
    tab.database = database;
    tab.schema = undefined;
    tab.objectBrowser = undefined;
    clearResultPayload(tab);
    tab.lastExecutedSql = undefined;
    tab.resultBaseSql = undefined;
    tab.resultSortedSql = undefined;
    clearExplain(tab);
    tab.tableMeta = undefined;
  }

  function updateSchema(id: string, schema: string | undefined) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || tab.schema === schema) return;
    tab.schema = schema;
    if (tab.mode === "objects") tab.objectBrowser = { ...tab.objectBrowser, schema };
  }

  function updateConnection(id: string, connectionId: string, database = "") {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || tab.connectionId === connectionId) return;
    void closeResultSession(tab);
    void closeClientConnectionSession(tab);
    tab.connectionId = connectionId;
    tab.database = database;
    tab.schema = undefined;
    clearResultPayload(tab);
    tab.lastExecutedSql = undefined;
    tab.resultBaseSql = undefined;
    tab.resultSortedSql = undefined;
    clearExplain(tab);
    tab.tableMeta = undefined;
  }

  function setTableMeta(id: string, meta: NonNullable<QueryTab["tableMeta"]>) {
    const tab = tabs.value.find((t) => t.id === id);
    if (tab) tab.tableMeta = meta;
  }

  function setObjectSource(id: string, objectSource: NonNullable<QueryTab["objectSource"]>) {
    const tab = tabs.value.find((t) => t.id === id);
    if (tab) tab.objectSource = objectSource;
  }

  function setExecuting(id: string, isExecuting: boolean) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    tab.isExecuting = isExecuting;
    tab.queryExecutionStartedAt = isExecuting ? Date.now() : undefined;
    if (!isExecuting) {
      tab.isCancelling = false;
      tab.executionId = undefined;
    }
  }

  function setExecutingWithId(id: string, executionId: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    tab.isExecuting = true;
    tab.executionId = executionId;
    tab.isCancelling = false;
    tab.queryExecutionStartedAt = Date.now();
  }

  function clearExplain(tab: QueryTab) {
    tab.explainPlan = undefined;
    tab.explainError = undefined;
    tab.explainSql = undefined;
    tab.lastExplainedSql = undefined;
    tab.isExplaining = false;
    tab.explainExecutionId = undefined;
  }

  function toErrorResult(e: any): NonNullable<QueryTab["result"]> {
    const message = e instanceof Error ? e.message : String(e);
    return markQueryResultRowsRaw({
      columns: ["Error"],
      rows: [[message]],
      affected_rows: 0,
      execution_time_ms: 0,
    });
  }

  function setErrorResult(id: string, e: any) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    tab.result = toErrorResult(e);
    tab.results = undefined;
    tab.activeResultIndex = undefined;
    tab.resultSessionId = undefined;
    tab.isExecuting = false;
    tab.isCancelling = false;
    tab.queryExecutionStartedAt = undefined;
    tab.executionId = undefined;
  }

  async function executeCurrentTab() {
    const tab = tabs.value.find((t) => t.id === activeTabId.value);
    if (!tab || !tab.sql.trim()) return;

    await executeCurrentSql(tab.sql);
  }

  async function executeCurrentSql(sql: string, options?: { skipRedisSafetyCheck?: boolean }) {
    if (!activeTabId.value) return;
    await executeTabSql(activeTabId.value, sql, { resultBaseSql: sql, resultSortedSql: undefined, ...options });
  }

  type QueryMetadataPatch = Pick<QueryTab, "queryAnalysis" | "querySourceColumns" | "queryEditabilityReason" | "tableMeta">;

  function applyQueryMetadataPatch(tab: QueryTab, patch: QueryMetadataPatch) {
    tab.queryAnalysis = patch.queryAnalysis;
    tab.querySourceColumns = patch.querySourceColumns;
    tab.queryEditabilityReason = patch.queryEditabilityReason;
    tab.tableMeta = patch.tableMeta;
  }

  async function buildQueryMetadataPatch(tab: QueryTab, sql: string, traceId?: string, elapsed?: () => string): Promise<QueryMetadataPatch | undefined> {
    if (tab.mode !== "query") return;
    if (!tab.result || !tab.result.columns.length) {
      return {
        queryAnalysis: undefined,
        querySourceColumns: undefined,
        queryEditabilityReason: undefined,
        tableMeta: undefined,
      };
    }

    console.info("[DBX][executeTabSql:metadata:editability:start]", { traceId, elapsed: elapsed?.() });
    const editability = await api.analyzeEditableQueryEditability(sql);
    console.info("[DBX][executeTabSql:metadata:editability:done]", {
      traceId,
      editable: editability.editable,
      reason: editability.editable ? undefined : editability.reason,
      elapsed: elapsed?.(),
    });
    if (!editability.editable) {
      return {
        queryAnalysis: undefined,
        querySourceColumns: undefined,
        queryEditabilityReason: editability.reason,
        tableMeta: undefined,
      };
    }
    const analysis = editability.analysis;

    if (!tab.connectionId || !tab.database) {
      return {
        queryAnalysis: undefined,
        querySourceColumns: undefined,
        queryEditabilityReason: "metadata-unavailable",
        tableMeta: undefined,
      };
    }

    // Resolve schema per database type
    const connStore = useConnectionStore();
    const conn = connStore.getConfig(tab.connectionId);
    const dbType = conn?.db_type || "";
    let schema = analysis.schema || tab.schema;
    if (!schema) {
      if (dbType === "postgres" || dbType === "kwdb") schema = "public";
      else schema = "";
    }
    const metadataSchema = normalizeOracleLikeMetadataIdentifier(dbType, schema || undefined, analysis.schema ? analysis.schemaQuoted : false) || "";
    const metadataTableName = normalizeOracleLikeMetadataIdentifier(dbType, analysis.tableName, analysis.tableNameQuoted)!;
    const metadataAnalysis = normalizeOracleLikeQueryAnalysis(dbType, analysis, metadataSchema || undefined, metadataTableName);

    try {
      console.info("[DBX][executeTabSql:metadata:get-columns:start]", {
        traceId,
        schema: metadataSchema,
        table: metadataTableName,
        elapsed: elapsed?.(),
      });
      const columns = await api.getColumns(tab.connectionId, tab.database, metadataSchema, metadataTableName);
      console.info("[DBX][executeTabSql:metadata:get-columns:done]", {
        traceId,
        columnCount: columns.length,
        elapsed: elapsed?.(),
      });
      const primaryKeys = editablePrimaryKeys(dbType as DatabaseType, columns);
      const tableMeta = {
        schema: metadataSchema || undefined,
        tableName: metadataTableName,
        columns,
        primaryKeys,
      };

      if (primaryKeys.length === 0) {
        return {
          queryAnalysis: undefined,
          querySourceColumns: undefined,
          queryEditabilityReason: "no-primary-key",
          tableMeta,
        };
      }

      if (!allPrimaryKeysPresent(primaryKeys, tab.result.columns, metadataAnalysis)) {
        return {
          queryAnalysis: undefined,
          querySourceColumns: undefined,
          queryEditabilityReason: "primary-key-not-returned",
          tableMeta,
        };
      }

      if (!allEditableColumnsWriteable(metadataAnalysis, tab.result.columns)) {
        return {
          queryAnalysis: undefined,
          querySourceColumns: undefined,
          queryEditabilityReason: "aliased-columns",
          tableMeta,
        };
      }

      return {
        queryAnalysis: metadataAnalysis,
        querySourceColumns: sourceColumnsForResult(metadataAnalysis, tab.result.columns),
        queryEditabilityReason: undefined,
        tableMeta,
      };
    } catch (err) {
      console.error("[DBX] ERROR fetching columns for query metadata:", err);
      return {
        queryAnalysis: undefined,
        querySourceColumns: undefined,
        queryEditabilityReason: "metadata-unavailable",
        tableMeta: undefined,
      };
    }
  }

  function analyzeQueryMetadataInBackground(tabId: string, sql: string, result: QueryResult, traceId: string, elapsed: () => string) {
    void (async () => {
      const tab = tabs.value.find((t) => t.id === tabId);
      if (!tab || tab.result !== result) return;
      console.info("[DBX][executeTabSql:metadata:start]", { traceId, elapsed: elapsed() });
      const patch = await buildQueryMetadataPatch(tab, sql, traceId, elapsed);
      const current = tabs.value.find((t) => t.id === tabId);
      if (patch && current?.result === result) {
        applyQueryMetadataPatch(current, patch);
        syncActiveResultRunFromDisplayed(current);
        console.info("[DBX][executeTabSql:metadata:done]", { traceId, elapsed: elapsed() });
      } else {
        console.warn("[DBX][executeTabSql:metadata:stale]", { traceId, elapsed: elapsed() });
      }
    })();
  }

  function setQueryTotalRowCountIfCurrent(tabId: string, executionId: string, result: QueryResult, totalRowCount: number | undefined) {
    const current = tabs.value.find((t) => t.id === tabId);
    if (current?.mode !== "query") return;
    if (current.executionId !== executionId && current.result !== result) return;
    current.resultTotalRowCount = totalRowCount;
    current.resultTotalRowCountLoading = false;
    syncActiveResultRunFromDisplayed(current);
  }

  function countQueryTotalRowsInBackground(options: { tabId: string; connectionId: string; database: string; schema?: string; countSql?: string; result: QueryResult; pageLimit?: number; pageOffset?: number; executionId: string; traceId: string; elapsed: () => string; timeoutSecs: number }) {
    const resultRowCount = options.result.rows.length;
    if (!options.countSql || resultRowCount <= 0) {
      setQueryTotalRowCountIfCurrent(options.tabId, options.executionId, options.result, undefined);
      return;
    }
    const countSql = options.countSql;

    if (typeof options.pageLimit === "number" && resultRowCount < options.pageLimit) {
      setQueryTotalRowCountIfCurrent(options.tabId, options.executionId, options.result, (options.pageOffset ?? 0) + resultRowCount);
      return;
    }

    void (async () => {
      try {
        console.info("[DBX][executeTabSql:count:start]", { traceId: options.traceId, elapsed: options.elapsed() });
        const countResult = await api.executeQuery(options.connectionId, options.database, countSql, options.schema, undefined, { timeoutSecs: options.timeoutSecs });
        const total = Number(countResult.rows?.[0]?.[0] ?? 0);
        if (!Number.isFinite(total) || total < 0) {
          setQueryTotalRowCountIfCurrent(options.tabId, options.executionId, options.result, undefined);
          return;
        }
        setQueryTotalRowCountIfCurrent(options.tabId, options.executionId, options.result, total);
        console.info("[DBX][executeTabSql:count:done]", {
          traceId: options.traceId,
          total,
          elapsed: options.elapsed(),
        });
      } catch (error) {
        setQueryTotalRowCountIfCurrent(options.tabId, options.executionId, options.result, undefined);
        console.warn("[DBX][executeTabSql:count:error]", {
          traceId: options.traceId,
          elapsed: options.elapsed(),
          error,
        });
      }
    })();
  }

  async function executeTabSql(
    id: string,
    sql: string,
    options?: {
      resultBaseSql?: string;
      resultSortedSql?: string | undefined;
      pagination?: { limit: number; offset: number; sessionId?: string };
      mongoSafety?: MongoAggregateSafetyOptions;
      preserveResultDuringExecution?: boolean;
      preserveTotalRowCountDuringExecution?: boolean;
      skipRedisSafetyCheck?: boolean;
    },
  ) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || !sql.trim()) return;

    const executionId = uuid();
    const traceId = executionId.slice(0, 8);
    const startedAt = performance.now();
    const elapsed = () => `${Math.round(performance.now() - startedAt)}ms`;
    tab.isExecuting = true;
    tab.isCancelling = false;
    if (!tab.queryExecutionStartedAt) {
      tab.queryExecutionStartedAt = Date.now();
    }
    tab.executionId = executionId;
    tab.lastExecutedSql = sql;
    if (!options?.preserveTotalRowCountDuringExecution) {
      tab.resultTotalRowCount = undefined;
    }
    tab.resultTotalRowCountLoading = false;
    const previousResultSessionClose = closeResultSession(tab, options?.pagination?.sessionId);
    if (!options?.preserveResultDuringExecution || !tab.result) {
      clearResultPayload(tab);
    }
    console.info("[DBX][executeTabSql:start]", {
      traceId,
      tabId: id,
      mode: tab.mode,
      connectionId: tab.connectionId,
      database: tab.database,
      schema: tab.schema,
      sql,
    });
    const queryBaseSql = options?.resultBaseSql ?? sql;
    let sqlToExecute = sql;
    let pageSql: string | undefined;
    let pageLimit: number | undefined;
    let pageOffset: number | undefined;
    let countSql: string | undefined;
    let useAgentResultSession = false;
    try {
      const connStore = useConnectionStore();
      await connStore.ensureConnected(tab.connectionId);
      const conn = connStore.getConfig(tab.connectionId);
      const effectiveDbType = effectiveDatabaseTypeForConnection(conn);
      const useAgentCursor = supportsDatabaseFeature(conn?.db_type, "driverManagement");
      const queryTimeoutSecs = queryTimeoutSecsForConnection(conn);
      const settingsStore = useSettingsStore();
      await previousResultSessionClose;

      // Redis command execution — split multi-line input into individual commands
      if (conn?.db_type === "redis") {
        await connStore.ensureConnected(tab.connectionId);
        let currentDb = Number(tab.database) || 0;
        const commands = sql
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        if (commands.length === 0) return;
        console.info("[DBX][executeTabSql:redis:start]", { traceId, db: currentDb, commandCount: commands.length, sql });

        const allResults: QueryResult[] = [];
        const skipSafety = options?.skipRedisSafetyCheck;
        for (const command of commands) {
          try {
            const result = await api.redisExecuteCommand(tab.connectionId, currentDb, command, skipSafety);
            allResults.push(markQueryResultRowsRaw(redisCommandResultToQueryResult(result.value, performance.now() - startedAt, result.command)));
            // Track db switches from SELECT N so later commands in the same batch run on the right db.
            currentDb = nextRedisCommandDb(currentDb, command, result.value);
          } catch (e: any) {
            allResults.push({ columns: ["Error"], rows: [[e?.message ?? String(e)]], affected_rows: 0, execution_time_ms: 0 });
          }
        }
        console.info("[DBX][executeTabSql:redis:done]", { traceId, commandCount: commands.length, elapsed: elapsed() });

        const current = tabs.value.find((t) => t.id === id);
        if (current?.executionId === executionId) {
          if (allResults.length > 1) {
            const activeResultIndex = allResults.findIndex((r) => !r.columns.includes("Error"));
            const resultIndex = activeResultIndex >= 0 ? activeResultIndex : 0;
            current.results = allResults;
            current.activeResultIndex = resultIndex;
            current.result = allResults[resultIndex];
          } else {
            current.results = undefined;
            current.activeResultIndex = undefined;
            current.result = allResults[0];
          }
          touchResult(current);
          current.queryAnalysis = undefined;
          current.querySourceColumns = undefined;
          current.queryEditabilityReason = undefined;
          current.tableMeta = undefined;
          current.resultBaseSql = options?.resultBaseSql ?? sql;
          current.resultSortedSql = options?.resultSortedSql;
          captureDisplayedResultRun(current, options?.resultBaseSql ?? sql);
          // Reflect db switches from SELECT N in the tab so the toolbar dropdown, tab title and
          // sidebar stay in sync with the command's effective db.
          if (current.database !== String(currentDb)) {
            current.database = String(currentDb);
          }
        }
        return;
      }

      if (tab.mode === "query") {
        const pagination = options?.pagination ?? { limit: settingsStore.editorSettings.pageSize, offset: 0 };
        const plan = await api.prepareQueryPaginationExecutionPlan({
          sql,
          queryBaseSql,
          databaseType: effectiveDbType,
          pagination,
          useAgentCursor,
        });
        sqlToExecute = plan.sqlToExecute;
        pageSql = plan.pageSql;
        pageLimit = plan.pageLimit;
        pageOffset = plan.pageOffset;
        countSql = plan.countSql;
        useAgentResultSession = plan.useAgentResultSession;
      } else if (tab.mode === "data") {
        pageLimit = options?.pagination?.limit ?? settingsStore.editorSettings.pageSize;
        pageOffset = options?.pagination?.offset ?? 0;
      }
      const mongoFind = conn?.db_type === "mongodb" ? parseMongoFindCommand(sql) : null;
      if (mongoFind) {
        await connStore.ensureConnected(tab.connectionId);
        console.info("[DBX][executeTabSql:mongo-find:start]", { traceId, collection: mongoFind.collection });
        const result = await api.mongoFindDocuments(tab.connectionId, tab.database, mongoFind.collection, mongoFind.skip, mongoFind.limit, mongoFind.filter, mongoFind.sort, executionId);
        console.info("[DBX][executeTabSql:mongo-find:done]", {
          traceId,
          rowCount: result.documents.length,
          total: result.total,
          elapsed: elapsed(),
        });
        const current = tabs.value.find((t) => t.id === id);
        if (current?.executionId === executionId) {
          current.results = undefined;
          current.activeResultIndex = undefined;
          current.result = markQueryResultRowsRaw(mongoDocumentsToQueryResult(result.documents, performance.now() - startedAt, result.total));
          touchResult(current);
          current.queryAnalysis = undefined;
          current.querySourceColumns = undefined;
          current.queryEditabilityReason = undefined;
          current.tableMeta = undefined;
          current.resultBaseSql = options?.resultBaseSql ?? sql;
          current.resultSortedSql = options?.resultSortedSql;
          captureDisplayedResultRun(current, options?.resultBaseSql ?? sql);
        }
        return;
      }
      const mongoCount = conn?.db_type === "mongodb" ? parseMongoCountDocumentsCommand(sql) : null;
      if (mongoCount) {
        await connStore.ensureConnected(tab.connectionId);
        console.info("[DBX][executeTabSql:mongo-count:start]", { traceId, collection: mongoCount.collection });
        const result = await api.mongoFindDocuments(tab.connectionId, tab.database, mongoCount.collection, 0, 1, mongoCount.filter, undefined, executionId);
        console.info("[DBX][executeTabSql:mongo-count:done]", {
          traceId,
          total: result.total,
          elapsed: elapsed(),
        });
        const current = tabs.value.find((t) => t.id === id);
        if (current?.executionId === executionId) {
          current.results = undefined;
          current.activeResultIndex = undefined;
          current.result = markQueryResultRowsRaw(mongoCountToQueryResult(result.total, performance.now() - startedAt));
          touchResult(current);
          current.queryAnalysis = undefined;
          current.querySourceColumns = undefined;
          current.queryEditabilityReason = undefined;
          current.tableMeta = undefined;
          current.resultBaseSql = options?.resultBaseSql ?? sql;
          current.resultSortedSql = options?.resultSortedSql;
          captureDisplayedResultRun(current, options?.resultBaseSql ?? sql);
        }
        return;
      }

      const mongoAggregate = conn?.db_type === "mongodb" ? parseMongoAggregateCommand(sql) : null;
      if (mongoAggregate) {
        if (options?.mongoSafety) {
          const safety = evaluateMongoAggregateSafety(mongoAggregate, options.mongoSafety);
          if (!safety.allowed) throw new Error(safety.reason);
        }
        await connStore.ensureConnected(tab.connectionId);
        console.info("[DBX][executeTabSql:mongo-aggregate:start]", { traceId, collection: mongoAggregate.collection });
        const result = await api.mongoAggregateDocuments(tab.connectionId, tab.database, mongoAggregate.collection, mongoAggregate.pipeline, pageLimit, executionId);
        console.info("[DBX][executeTabSql:mongo-aggregate:done]", {
          traceId,
          rowCount: result.documents.length,
          total: result.total,
          elapsed: elapsed(),
        });
        const current = tabs.value.find((t) => t.id === id);
        if (current?.executionId === executionId) {
          current.results = undefined;
          current.activeResultIndex = undefined;
          current.result = markQueryResultRowsRaw(mongoDocumentsToQueryResult(result.documents, performance.now() - startedAt, result.total));
          touchResult(current);
          current.queryAnalysis = undefined;
          current.querySourceColumns = undefined;
          current.queryEditabilityReason = undefined;
          current.tableMeta = undefined;
          current.resultBaseSql = options?.resultBaseSql ?? sql;
          current.resultSortedSql = options?.resultSortedSql;
          captureDisplayedResultRun(current, options?.resultBaseSql ?? sql);
        }
        return;
      }

      const mongoGetIndexes = conn?.db_type === "mongodb" ? parseMongoGetIndexesCommand(sql) : null;
      if (mongoGetIndexes) {
        await connStore.ensureConnected(tab.connectionId);
        console.info("[DBX][executeTabSql:mongo-indexes:start]", { traceId, collection: mongoGetIndexes.collection });
        const indexes = await api.listIndexes(tab.connectionId, tab.database, "", mongoGetIndexes.collection);
        console.info("[DBX][executeTabSql:mongo-indexes:done]", {
          traceId,
          indexCount: indexes.length,
          elapsed: elapsed(),
        });
        const current = tabs.value.find((t) => t.id === id);
        if (current?.executionId === executionId) {
          current.results = undefined;
          current.activeResultIndex = undefined;
          current.result = markQueryResultRowsRaw(mongoIndexesToQueryResult(indexes, performance.now() - startedAt));
          touchResult(current);
          current.queryAnalysis = undefined;
          current.querySourceColumns = undefined;
          current.queryEditabilityReason = undefined;
          current.tableMeta = undefined;
          current.resultBaseSql = options?.resultBaseSql ?? sql;
          current.resultSortedSql = options?.resultSortedSql;
          captureDisplayedResultRun(current, options?.resultBaseSql ?? sql);
        }
        return;
      }

      const mongoWrite = conn?.db_type === "mongodb" ? parseMongoWriteCommand(sql) : null;
      if (mongoWrite) {
        await connStore.ensureConnected(tab.connectionId);
        console.info("[DBX][executeTabSql:mongo-write:start]", {
          traceId,
          kind: mongoWrite.kind,
          collection: mongoWrite.collection,
        });
        let affectedRows = 0;
        if (mongoWrite.kind === "insert") {
          const result = await api.mongoInsertDocuments(tab.connectionId, tab.database, mongoWrite.collection, mongoWrite.docsJson);
          affectedRows = result.affected_rows;
        } else if (mongoWrite.kind === "update") {
          const result = await api.mongoUpdateDocuments(tab.connectionId, tab.database, mongoWrite.collection, mongoWrite.filter, mongoWrite.update, mongoWrite.many);
          affectedRows = result.affected_rows;
        } else {
          const result = await api.mongoDeleteDocuments(tab.connectionId, tab.database, mongoWrite.collection, mongoWrite.filter, mongoWrite.many);
          affectedRows = result.affected_rows;
        }
        console.info("[DBX][executeTabSql:mongo-write:done]", {
          traceId,
          affectedRows,
          elapsed: elapsed(),
        });
        const current = tabs.value.find((t) => t.id === id);
        if (current?.executionId === executionId) {
          current.results = undefined;
          current.activeResultIndex = undefined;
          current.result = markQueryResultRowsRaw(mongoWriteToQueryResult(affectedRows, performance.now() - startedAt));
          touchResult(current);
          current.queryAnalysis = undefined;
          current.querySourceColumns = undefined;
          current.queryEditabilityReason = undefined;
          current.tableMeta = undefined;
          current.resultBaseSql = options?.resultBaseSql ?? sql;
          current.resultSortedSql = options?.resultSortedSql;
          captureDisplayedResultRun(current, options?.resultBaseSql ?? sql);
        }
        return;
      }

      console.info("[DBX][executeTabSql:execute-multi:start]", { traceId, elapsed: elapsed() });
      const clientSessionId = tab.mode === "query" ? tab.id : undefined;
      const executionOptions = {
        ...(typeof pageLimit === "number"
          ? useAgentResultSession
            ? {
                maxRows: pageLimit,
                fetchSize: pageLimit,
                pageSize: pageLimit,
                resultSessionId: options?.pagination?.sessionId,
              }
            : { maxRows: pageLimit, fetchSize: pageLimit }
          : {}),
        ...(clientSessionId ? { clientSessionId } : {}),
        timeoutSecs: queryTimeoutSecs,
      };
      const executionSchema = connectionUsesSchemaExecutionContext(conn) ? tab.schema || tab.database : tab.mode === "data" || connectionUsesDatabaseObjectTreeMode(conn) ? undefined : tab.schema;
      const executionPromise = api.executeMulti(tab.connectionId, tab.database, sqlToExecute, executionSchema, executionId, executionOptions);
      const frontendTimeoutSecs = Math.max(queryTimeoutSecs * 2, 60);
      const results = markQueryResultsRowsRaw(await withFrontendQueryTimeout(executionPromise, queryTimeoutSecs === 0 ? 0 : frontendTimeoutSecs, t("editor.queryTimeoutError", { seconds: frontendTimeoutSecs })));
      console.info("[DBX][executeTabSql:execute-multi:done]", {
        traceId,
        resultCount: results.length,
        rowCounts: results.map((result) => result.rows.length),
        columnCounts: results.map((result) => result.columns.length),
        elapsed: elapsed(),
      });
      const current = tabs.value.find((t) => t.id === id);
      if (current?.executionId === executionId) {
        if (results.length > 1) {
          const activeResultIndex = results.findIndex((result) => result.columns.length > 0);
          const resultIndex = activeResultIndex >= 0 ? activeResultIndex : 0;
          current.results = results;
          current.activeResultIndex = resultIndex;
          current.result = results[resultIndex];
        } else {
          current.results = undefined;
          current.activeResultIndex = undefined;
          current.result = results[0];
        }
        current.resultBaseSql = queryBaseSql;
        current.resultSortedSql = options?.resultSortedSql;
        current.resultPageSql = pageSql;
        current.resultPageLimit = pageLimit;
        current.resultPageOffset = pageOffset;
        current.resultCountSql = countSql;
        current.resultSessionId = current.result?.session_id ?? undefined;
        if (!options?.preserveTotalRowCountDuringExecution) {
          current.resultTotalRowCount = undefined;
        }
        current.resultTotalRowCountLoading = current.mode === "query" && !!current.result && !!countSql;
        // Server-side pagination without a countSql: the backend (currently
        // the Elasticsearch driver) already reports the true match total via
        // affected_rows. Use it directly so the result-grid can compute the
        // page count without issuing a separate COUNT query.
        if (current.result && current.mode === "query" && typeof pageLimit === "number" && !countSql && typeof current.result.affected_rows === "number") {
          current.resultTotalRowCount = current.result.affected_rows;
          current.resultTotalRowCountLoading = false;
        }
        touchResult(current);
        captureDisplayedResultRun(current, queryBaseSql);
        if (current.mode === "query" && current.result) {
          countQueryTotalRowsInBackground({
            tabId: id,
            connectionId: current.connectionId,
            database: current.database,
            schema: current.schema,
            countSql,
            result: current.result,
            pageLimit,
            pageOffset,
            executionId,
            traceId,
            elapsed,
            timeoutSecs: queryTimeoutSecs,
          });
        }
        console.info("[DBX][executeTabSql:result:assigned]", {
          traceId,
          activeResultIndex: current.activeResultIndex,
          rowCount: current.result?.rows.length ?? 0,
          columnCount: current.result?.columns.length ?? 0,
          backendMs: current.result?.execution_time_ms,
          elapsed: elapsed(),
        });
        if (current.mode === "query" && current.result) analyzeQueryMetadataInBackground(id, queryBaseSql, current.result, traceId, elapsed);
      } else {
        console.warn("[DBX][executeTabSql:stale-result]", {
          traceId,
          currentExecutionId: current?.executionId,
          elapsed: elapsed(),
        });
      }
    } catch (e: any) {
      console.error("[DBX][executeTabSql:error]", { traceId, elapsed: elapsed(), error: e });
      const current = tabs.value.find((t) => t.id === id);
      if (current?.executionId === executionId) {
        current.result = toErrorResult(e);
        current.results = undefined;
        current.activeResultIndex = undefined;
        current.queryAnalysis = undefined;
        current.querySourceColumns = undefined;
        current.queryEditabilityReason = undefined;
        if (current.mode !== "data") current.tableMeta = undefined;
        current.resultBaseSql = queryBaseSql;
        current.resultSortedSql = options?.resultSortedSql;
        current.resultPageSql = pageSql;
        current.resultPageLimit = pageLimit;
        current.resultPageOffset = pageOffset;
        current.resultCountSql = countSql;
        current.resultSessionId = undefined;
        current.resultTotalRowCount = undefined;
        current.resultTotalRowCountLoading = false;
        touchResult(current);
        captureDisplayedResultRun(current, queryBaseSql);
      }
    } finally {
      const current = tabs.value.find((t) => t.id === id);
      if (current?.executionId === executionId) {
        current.isExecuting = false;
        current.isCancelling = false;
        current.queryExecutionStartedAt = undefined;
        current.executionId = undefined;
        console.info("[DBX][executeTabSql:finish]", { traceId, elapsed: elapsed() });
      } else {
        console.warn("[DBX][executeTabSql:finish-stale]", {
          traceId,
          currentExecutionId: current?.executionId,
          elapsed: elapsed(),
        });
      }
    }
    await trimResultCache();
  }

  async function explainTabSql(id: string, sql: string, databaseType?: DatabaseType, explainMode?: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return { ok: false as const, reason: "empty" as const };
    const conn = useConnectionStore().getConfig(tab.connectionId);
    const queryTimeoutSecs = queryTimeoutSecsForConnection(conn);
    const executionId = uuid();

    tab.isExplaining = true;
    tab.explainExecutionId = executionId;
    tab.explainError = undefined;
    tab.lastExplainedSql = sql;

    // DM uses native getExplainInfo via JDBC (supports explain + autotrace modes)
    // Autotrace mode executes the SQL — reject dangerous statements
    if (databaseType === "dameng") {
      if (explainMode === "autotrace") {
        const DANGER_RE = /^\s*(DROP|DELETE|TRUNCATE|ALTER|UPDATE|MERGE|REPLACE)\b/i;
        const cleaned = sql
          .replace(/\/\*[\s\S]*?\*\//g, " ")
          .replace(/--.*$/gm, " ")
          .replace(/#.*$/gm, " ");
        if (cleaned.split(";").some((stmt) => DANGER_RE.test(stmt))) {
          tab.isExplaining = false;
          tab.explainExecutionId = undefined;
          return { ok: false as const, reason: "unsafe" as const };
        }
      }
      try {
        const mode = explainMode === "autotrace" ? "autotrace" : "explain";
        const planText = (await api.getExplainInfo(tab.connectionId, tab.database, tab.schema, sql, mode)) as string | undefined;
        const current = tabs.value.find((t) => t.id === id);
        if (current?.explainExecutionId === executionId) {
          if (planText && planText.length > 0) {
            current.explainPlan = parseDamengExplainText(planText);
            current.explainSql = sql;
            current.explainError = undefined;
          } else {
            current.explainPlan = undefined;
            current.explainError = "No explain plan returned";
          }
        }
      } catch (e: any) {
        const current = tabs.value.find((t) => t.id === id);
        if (current?.explainExecutionId === executionId) {
          current.explainPlan = undefined;
          current.explainError = String(e?.message || e);
        }
      } finally {
        const current = tabs.value.find((t) => t.id === id);
        if (current?.explainExecutionId === executionId) {
          current.isExplaining = false;
        }
      }
      return { ok: true as const };
    }

    const built = await buildExplainSql(databaseType, sql);
    if (!built.ok) {
      tab.explainPlan = undefined;
      tab.explainError = built.reason;
      return built;
    }

    tab.explainSql = built.sql;
    try {
      const result = await api.executeQuery(tab.connectionId, tab.database, built.sql, tab.schema, executionId, {
        timeoutSecs: queryTimeoutSecs,
      });
      const current = tabs.value.find((t) => t.id === id);
      if (current?.explainExecutionId === executionId) {
        current.explainPlan = parseExplainResult(databaseType as "mysql" | "postgres", result);
        current.explainError = undefined;
      }
    } catch (e: any) {
      const current = tabs.value.find((t) => t.id === id);
      if (current?.explainExecutionId === executionId) {
        current.explainPlan = undefined;
        current.explainError = String(e?.message || e);
      }
    } finally {
      const current = tabs.value.find((t) => t.id === id);
      if (current?.explainExecutionId === executionId) {
        current.isExplaining = false;
        current.explainExecutionId = undefined;
      }
    }
    return { ok: true as const, sql: built.sql };
  }

  async function cancelTabExecution(id: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || !canCancelQueryExecution(tab)) return false;

    const executionId = tab.executionId;
    if (!executionId) return false;
    tab.isCancelling = true;
    try {
      const canceled = await api.cancelQuery(executionId);
      if (!canceled) {
        const current = tabs.value.find((t) => t.id === id);
        if (current && current.executionId === executionId) {
          current.isExecuting = false;
          current.isCancelling = false;
          current.executionId = undefined;
          current.queryExecutionStartedAt = undefined;
        }
      }
      return canceled;
    } catch (e: any) {
      const current = tabs.value.find((t) => t.id === id);
      if (current && current.executionId === executionId) {
        current.isCancelling = false;
        current.result = toErrorResult(e);
      }
      return false;
    }
  }

  async function cancelTabExplain(id: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab?.isExplaining || !tab.explainExecutionId) return false;

    const executionId = tab.explainExecutionId;
    try {
      const canceled = await api.cancelQuery(executionId);
      if (!canceled) {
        const current = tabs.value.find((t) => t.id === id);
        if (current && current.explainExecutionId === executionId) current.isExplaining = false;
      }
      return canceled;
    } catch (e: any) {
      const current = tabs.value.find((t) => t.id === id);
      if (current && current.explainExecutionId === executionId) {
        current.isExplaining = false;
        current.explainError = String(e?.message || e);
      }
      return false;
    }
  }

  function setActiveResultIndex(id: string, index: number) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab?.results || index < 0 || index >= tab.results.length) return;
    tab.activeResultIndex = index;
    tab.result = tab.results[index];
    touchResult(tab);
    tab.queryAnalysis = undefined;
    tab.querySourceColumns = undefined;
    tab.queryEditabilityReason = undefined;
    syncActiveResultRunFromDisplayed(tab);
  }

  function notifyConnectionMayBeLost() {
    const stuck = tabs.value.filter((t) => t.isExecuting);
    if (stuck.length > 0) {
      stuck.forEach((tab) => {
        tab.isExecuting = false;
        tab.isCancelling = false;
        tab.queryExecutionStartedAt = undefined;
        tab.executionId = undefined;
        tab.result = toErrorResult(new Error(t("editor.connectionMayBeLost")));
      });
    }
  }

  async function trimResultCache() {
    const inactive = tabs.value.filter((t) => t.id !== activeTabId.value && (t.result || t.results)).sort((a, b) => (a.resultAccessedAt ?? 0) - (b.resultAccessedAt ?? 0));
    if (inactive.length > MAX_CACHED_RESULTS) {
      const toEvict = inactive.slice(0, inactive.length - MAX_CACHED_RESULTS);
      await Promise.all(toEvict.map((t) => evictCachedResult(t)));
    }
  }

  watch(activeTabId, (id) => {
    touchResult(tabs.value.find((tab) => tab.id === id));
  });

  function restoreCachedResultPayload(tab: QueryTab, snapshot: Awaited<ReturnType<typeof readTabResultSnapshot>>) {
    if (!snapshot) return false;
    const results = snapshot.results ? markQueryResultsRowsRaw(snapshot.results) : undefined;
    const activeIndex = snapshot.activeResultIndex ?? 0;
    tab.results = results;
    tab.activeResultIndex = snapshot.activeResultIndex;
    tab.result = snapshot.result ? markQueryResultRowsRaw(snapshot.result) : results?.[activeIndex] ? markQueryResultRowsRaw(results[activeIndex]) : undefined;
    tab.resultRuns = snapshot.resultRuns ? markQueryResultRunsRowsRaw(snapshot.resultRuns) : tab.resultRuns;
    tab.activeResultRunId = snapshot.activeResultRunId ?? tab.activeResultRunId;
    if (!tab.result && !tab.results && !tab.resultRuns) return false;

    tab.queryAnalysis = snapshot.queryAnalysis;
    tab.querySourceColumns = snapshot.querySourceColumns;
    tab.queryEditabilityReason = snapshot.queryEditabilityReason;
    tab.tableMeta = snapshot.tableMeta;
    tab.resultPageSql = snapshot.resultPageSql;
    tab.resultPageLimit = snapshot.resultPageLimit;
    tab.resultPageOffset = snapshot.resultPageOffset;
    tab.resultCountSql = snapshot.resultCountSql;
    tab.resultTotalRowCount = snapshot.resultTotalRowCount;
    tab.resultTotalRowCountLoading = false;
    tab.resultSessionId = undefined;
    tab.resultEvicted = undefined;
    tab.resultCacheState = "memory";
    touchResult(tab);
    return true;
  }

  async function resultArchiveSnapshotForTab(tab: QueryTab) {
    let snapshot = buildTabResultSnapshot(tab);
    if (tab.resultCacheKey && (!snapshot || tab.resultEvicted || !resultSnapshotHasPayload(snapshot))) {
      snapshot = (await readTabResultSnapshot(tab.resultCacheKey)) ?? snapshot;
    }
    return snapshot && resultSnapshotHasPayload(snapshot) ? snapshot : undefined;
  }

  async function exportResultArchive(id: string): Promise<Uint8Array | undefined> {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || tab.mode !== "query") return undefined;
    const snapshot = await resultArchiveSnapshotForTab(tab);
    if (!snapshot) return undefined;
    return encodeQueryResultArchive(tab, snapshot);
  }

  function openResultArchiveTab(archive: DecodedQueryResultArchive): string | undefined {
    const id = uuid();
    const title = archive.tab.title.trim() || t("tabs.importedResultArchive");
    const tab: QueryTab = {
      id,
      title,
      customTitle: true,
      connectionId: archive.tab.connectionId,
      database: archive.tab.database,
      schema: archive.tab.schema,
      sql: archive.tab.sql,
      originalSql: archive.tab.sql,
      lastExecutedSql: archive.tab.lastExecutedSql,
      resultBaseSql: archive.tab.resultBaseSql,
      resultSortedSql: archive.tab.resultSortedSql,
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "query",
    };
    if (!restoreCachedResultPayload(tab, archive.snapshot)) return undefined;
    const activeRun = tab.resultRuns?.find((run) => run.id === tab.activeResultRunId) ?? tab.resultRuns?.[0];
    if (activeRun) projectResultRun(tab, activeRun);
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  async function importResultArchive(bytes: Uint8Array | ArrayBuffer): Promise<string | undefined> {
    const archive = await decodeQueryResultArchive(bytes);
    if (!archive) return undefined;
    return openResultArchiveTab(archive);
  }

  async function reloadEvictedTab(id: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || !tab.resultEvicted) return;
    if (tab.resultCacheKey) {
      const restored = restoreCachedResultPayload(tab, await readTabResultSnapshot(tab.resultCacheKey));
      if (restored) return;
      tab.resultCacheState = "missing";
    }
    tab.resultEvicted = false;
    const sql = tab.lastExecutedSql ?? tab.sql;
    if (!sql?.trim()) return;
    const settingsStore = useSettingsStore();
    await executeTabSql(tab.id, sql, {
      resultBaseSql: tab.resultBaseSql ?? sql,
      resultSortedSql: tab.resultSortedSql,
      pagination:
        tab.mode === "data"
          ? {
              limit: tab.resultPageLimit ?? settingsStore.editorSettings.pageSize,
              offset: tab.resultPageOffset ?? 0,
            }
          : undefined,
    });
  }

  async function fetchTabResultForExport(id: string): Promise<QueryResult | undefined> {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab?.result) return undefined;

    if (tab.mode === "data") {
      const connStore = useConnectionStore();
      await connStore.ensureConnected(tab.connectionId);
      const conn = connStore.getConfig(tab.connectionId);
      const tableMeta = tableMetaForDataTab(tab);
      if (!tableMeta?.tableName) return tab.result;

      const pageLimit = TABLE_DATA_EXPORT_PAGE_SIZE;
      const effectiveDbType = effectiveDatabaseTypeForConnection(conn);
      const primaryKeys = tab.tableMeta ? editablePrimaryKeys(effectiveDbType, tab.tableMeta.columns, tab.tableMeta.tableType) : tableMeta.primaryKeys;
      const fallbackOrderColumns = effectiveDbType === "sqlserver" && !primaryKeys.length ? tableMeta.columns.slice(0, 1).map((column) => column.name) : undefined;
      const sortOrder = tab.resultSortColumn && tab.resultSortDirection ? `${quoteTableIdentifier(effectiveDbType, tab.resultSortColumn)} ${tab.resultSortDirection.toUpperCase()}` : undefined;
      const orderBy = tab.orderByInput?.trim() || sortOrder;
      const queryTimeoutSecs = queryTimeoutSecsForConnection(conn);
      const rows: QueryResult["rows"] = [];
      let columns: string[] = [];
      let executionTimeMs = 0;
      let offset = 0;

      while (true) {
        const sql = await api.buildTableSelectSql({
          databaseType: effectiveDbType,
          schema: tableMeta.schema,
          tableName: tableMeta.tableName,
          columns: tableMeta.columns.map((column) => column.name),
          primaryKeys,
          fallbackOrderColumns,
          whereInput: tab.whereInput,
          orderBy,
          limit: pageLimit,
          offset,
        });
        const results = await api.executeMulti(tab.connectionId, tab.database, sql, undefined, undefined, {
          maxRows: pageLimit,
          fetchSize: pageLimit,
          timeoutSecs: queryTimeoutSecs,
        });
        const result = results[0];
        if (!result) break;
        if (columns.length === 0) columns = result.columns;
        rows.push(...result.rows);
        executionTimeMs += result.execution_time_ms ?? 0;
        if (result.rows.length < pageLimit) break;
        offset += result.rows.length;
      }

      return {
        columns: columns.length ? columns : tab.result.columns,
        rows,
        affected_rows: 0,
        execution_time_ms: executionTimeMs,
        truncated: false,
        has_more: false,
      };
    }

    if (tab.mode !== "query") return tab.result;

    const sql = tab.resultSortedSql ?? tab.resultBaseSql ?? tab.lastExecutedSql ?? tab.sql;
    if (!sql.trim()) return tab.result;

    const connStore = useConnectionStore();
    await connStore.ensureConnected(tab.connectionId);
    const conn = connStore.getConfig(tab.connectionId);
    const effectiveDbType = effectiveDatabaseTypeForConnection(conn);
    const queryTimeoutSecs = queryTimeoutSecsForConnection(conn);
    const useAgentCursor = supportsDatabaseFeature(conn?.db_type, "driverManagement");
    const queryBaseSql = tab.resultBaseSql ?? sql;
    const pageLimit = Math.max(tab.resultPageLimit ?? 0, TABLE_DATA_EXPORT_PAGE_SIZE);
    const rows: QueryResult["rows"] = [];
    let columns: string[] = [];
    let executionTimeMs = 0;
    let offset = 0;
    let sessionId: string | undefined;
    const clientSessionId = `${tab.id}:export`;

    try {
      while (true) {
        const plan = await api.prepareQueryPaginationExecutionPlan({
          sql,
          queryBaseSql,
          databaseType: effectiveDbType,
          pagination: { limit: pageLimit, offset, sessionId },
          useAgentCursor,
        });
        if (typeof plan.pageLimit !== "number" || typeof plan.pageOffset !== "number") return tab.result;
        const executionOptions = plan.useAgentResultSession
          ? {
              maxRows: plan.pageLimit,
              fetchSize: plan.pageLimit,
              pageSize: plan.pageLimit,
              resultSessionId: sessionId,
              clientSessionId,
              timeoutSecs: queryTimeoutSecs,
            }
          : { maxRows: plan.pageLimit, fetchSize: plan.pageLimit, timeoutSecs: queryTimeoutSecs };
        const results = await api.executeMulti(tab.connectionId, tab.database, plan.sqlToExecute, tab.schema, undefined, executionOptions);
        const result = results[0];
        if (!result) break;
        if (columns.length === 0) columns = result.columns;
        rows.push(...result.rows);
        executionTimeMs += result.execution_time_ms ?? 0;
        sessionId = result.session_id ?? undefined;
        const shouldFetchNextPage = plan.useAgentResultSession ? result.has_more === true : result.rows.length >= plan.pageLimit;
        if (!shouldFetchNextPage) break;
        offset += result.rows.length;
      }
    } finally {
      if (sessionId) void api.closeQuerySession(tab.connectionId, tab.database, sessionId, clientSessionId);
    }

    return {
      columns: columns.length ? columns : tab.result.columns,
      rows,
      affected_rows: 0,
      execution_time_ms: executionTimeMs,
      truncated: false,
      has_more: false,
    };
  }

  return {
    tabs,
    activeTabId,
    showCloseConfirm,
    pendingCloseTabId,
    createTab,
    closeTab,
    forceClosePendingTab,
    cancelClosePendingTab,
    saveAndClosePendingTab,
    isTabDirty,
    markTabClean,
    closeOtherTabs,
    closeAllTabs,
    duplicateTab,
    closeConnectionTabs,
    closeDatabaseTabs,
    releaseConnectionTabs,
    releaseDatabaseTabs,
    updateSql,
    updateEditorViewport,
    updateEditorSelection,
    renameTab,
    openObjectBrowser,
    openUserAdmin,
    openTableStructure,
    linkSavedSql,
    openSavedSql,
    togglePinnedTab,
    reorderTab,
    updateDatabase,
    updateSchema,
    updateConnection,
    setTableMeta,
    invalidateTableStructure,
    tableStructureRefreshVersion,
    setObjectSource,
    setExecuting,
    setExecutingWithId,
    setErrorResult,
    setActiveResultRun,
    removeResultRun,
    setActiveResultIndex,
    executeCurrentTab,
    executeCurrentSql,
    executeTabSql,
    explainTabSql,
    cancelTabExecution,
    cancelTabExplain,
    reloadEvictedTab,
    exportResultArchive,
    importResultArchive,
    fetchTabResultForExport,
    notifyConnectionMayBeLost,
  };
});
