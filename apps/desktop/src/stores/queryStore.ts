import { defineStore } from "pinia";
import { uuid } from "@/lib/common/utils";
import { markRaw, ref, watch, computed } from "vue";
import { useI18n } from "vue-i18n";
import type { DatabaseType, QueryResult, QueryTab, TableInfoTab, TableStructureEditorTarget } from "@/types/database";
import { orderPinnedFirst } from "@/lib/app/pinnedItems";
import { canCancelQueryExecution } from "@/lib/sql/queryExecutionState";
import { buildExplainSql, parseExplainResult, parseDamengExplainText } from "@/lib/diagram/explainPlan";
import { allEditableColumnsWriteable, allPrimaryKeysPresent, analyzeEditableQuery, sourceColumnsForResult, type EditableQueryInfo } from "@/lib/sql/sqlAnalysis";
import { ACTIVE_TAB_STORAGE_KEY, OPEN_TABS_STORAGE_KEY, restoreOpenTabsPayload, restoreOpenTabsState, serializeOpenTabs } from "@/lib/app/openTabsPersistence";
import {
  evaluateMongoAggregateSafety,
  evaluateMongoWriteSafety,
  mongoCollectionStatsToQueryResult,
  mongoCountToQueryResult,
  mongoCreateIndexToQueryResult,
  mongoDocumentsToQueryResult,
  mongoDroppedIndexesToQueryResult,
  mongoIndexesToQueryResult,
  mongoUseToQueryResult,
  mongoVersionToQueryResult,
  mongoWriteToQueryResult,
  splitMongoCommandRanges,
  type MongoAggregateSafetyOptions,
} from "@/lib/mongo/mongoShellCommand";
import { redisCommandResultToQueryResult } from "@/lib/redis/redisQueryResult";
import { nextRedisCommandDb } from "@/lib/redis/redisCommandSession";
import { isRedisMutatingCommand } from "@/lib/redis/redisCommandTable";
import { usesAgentCursorForQuery } from "@/lib/database/databaseDriverManifest";
import { canUseKeylessRowPredicate } from "@/lib/table/tableEditing";
import { TABLE_DATA_EXPORT_PAGE_SIZE } from "@/lib/table/tableDataExport";
import { tableMetaForDataTab } from "@/lib/table/tableDataTabMeta";
import { tableOpenPageLimit } from "@/lib/table/tableOpenPageLimit";
import { loadTableMetadata } from "@/lib/metadata/tableMetadataCache";
import { quoteTableIdentifier } from "@/lib/table/tableSelectSql";
import { connectionUsesDatabaseObjectTreeMode, connectionUsesSchemaExecutionContext, effectiveDatabaseTypeForConnection, metadataSchemaForConnection } from "@/lib/database/jdbcDialect";
import { frontendQueryTimeoutSecsForSql, queryTimeoutSecsForConnection } from "@/lib/sql/queryTimeout";
import { sortDataGridRows, type DataGridSortDirection } from "@/lib/dataGrid/dataGridSort";
import { normalizeResultPageSize } from "@/lib/dataGrid/paginationPageSize";
import { splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";
import { clearDataGridPendingSnapshotsForTab } from "@/composables/useDataGridEditor";
import { buildTabResultSnapshot, deleteTabResultSnapshot, readTabResultSnapshot, tabResultCacheKey, writeTabResultSnapshot } from "@/lib/tabs/tabResultCache";
import { decodeQueryResultArchive, encodeQueryResultArchive, type DecodedQueryResultArchive } from "@/lib/query/queryResultArchive";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { createSavedSqlEditorPosition, initSavedSqlEditorPositions, restoreSavedSqlEditorPosition, saveSavedSqlEditorPosition } from "@/lib/app/savedSqlEditorPosition";
import { ensureSqlExtension } from "@/lib/savedSql/savedSqlFileName";
import { safeLocalStorageGet, safeLocalStorageRemove } from "@/lib/backend/safeStorage";
import type { SavedSqlFile } from "@/types/database";

const ORACLE_LIKE_METADATA_TYPES = new Set<string>(["oracle", "dameng", "oceanbase-oracle"]);
const BACKGROUND_CLIENT_SESSION_SUFFIXES = ["count", "explain", "export"] as const;
const CANCEL_QUERY_TIMEOUT_MS = 10_000;
const CANCEL_ACK_SETTLE_TIMEOUT_MS = 2_000;
const SAVED_SQL_EDITOR_POSITION_PERSIST_DELAY_MS = 500;
type CloseConfirmContext = "tab" | "batch" | "app";

function cloneTabDraft<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface BuildQueryResultExportRequestOptions {
  exportId: string;
  filePath: string;
  format: "csv" | "xlsx";
}

type DroppedTableObjectType = "TABLE" | "VIEW" | "MATERIALIZED_VIEW";

interface DroppedTableObjectTarget {
  connectionId: string;
  database: string;
  schema?: string;
  schemaCandidates?: Array<string | undefined>;
  name: string;
  objectType?: DroppedTableObjectType;
}

function tabClientSessionId(tab: Pick<QueryTab, "id">, suffix?: (typeof BACKGROUND_CLIENT_SESSION_SUFFIXES)[number]): string {
  return suffix ? `${tab.id}:${suffix}` : tab.id;
}

function resultRunCacheKey(tabId: string, runId: string): string {
  return `tab:${tabId}:run:${runId}`;
}

function normalizeOptionalSchema(schema: string | null | undefined): string {
  return schema?.trim() ?? "";
}

function droppedTableObjectSchemaCandidates(target: DroppedTableObjectTarget): Set<string> {
  const schemas = target.schemaCandidates?.length ? target.schemaCandidates : [target.schema];
  return new Set(schemas.map(normalizeOptionalSchema));
}

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

function queryResultSourceLabel(sql: string, database: string | undefined): string | undefined {
  const analysis = analyzeEditableQuery(sql);
  if (!analysis) return undefined;
  const qualifier = analysis.schema || database?.trim();
  return qualifier ? `${qualifier}.${analysis.tableName}` : analysis.tableName;
}

function annotateQueryResultSources(results: QueryResult[], sql: string, database: string | undefined, databaseType?: DatabaseType): QueryResult[] {
  const statements = splitSqlStatementRanges(sql, databaseType);
  let statementIndex = 0;
  for (const result of results) {
    const statement = statements[statementIndex++];
    if (!statement) continue;
    annotateQueryResultSource(result, statement.sql, database);
  }
  return results;
}

function annotateQueryResultSource(result: QueryResult, sourceStatement: string, database?: string): QueryResult {
  result.sourceStatement = sourceStatement;
  const label = queryResultSourceLabel(sourceStatement, database);
  if (label) result.sourceLabel = label;
  return result;
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

async function withCancelQueryTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Cancel request timed out after 10s.")), CANCEL_QUERY_TIMEOUT_MS);
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

let saveTabsQueue = Promise.resolve();

function saveTabs(tabs: QueryTab[], activeTabId: string | null): Promise<void> {
  const payload = { tabs: serializeOpenTabs(tabs), activeTabId };
  saveTabsQueue = saveTabsQueue.catch(() => undefined).then(() => api.saveOpenTabsState(payload));
  return saveTabsQueue;
}

function loadLegacySavedTabs(): { rawTabs: string | null; rawActiveTabId: string | null } {
  return {
    rawTabs: safeLocalStorageGet(OPEN_TABS_STORAGE_KEY),
    rawActiveTabId: safeLocalStorageGet(ACTIVE_TAB_STORAGE_KEY),
  };
}

function clearLegacySavedTabs() {
  safeLocalStorageRemove(OPEN_TABS_STORAGE_KEY);
  safeLocalStorageRemove(ACTIVE_TAB_STORAGE_KEY);
}

function restoreSavedTabsFromPayload(payload: { tabs?: unknown; activeTabId?: unknown } | null | undefined): { tabs: QueryTab[]; activeTabId: string | null } {
  const restoreMode = useSettingsStore().editorSettings.openTabsRestoreMode;
  if (restoreMode === "none") return { tabs: [], activeTabId: null };
  return restoreOpenTabsPayload(payload, {
    filter: restoreMode === "pinned" ? "pinned" : "all",
  });
}

function restoreLegacySavedTabs(): { tabs: QueryTab[]; activeTabId: string | null } {
  const restoreMode = useSettingsStore().editorSettings.openTabsRestoreMode;
  if (restoreMode === "none") return { tabs: [], activeTabId: null };
  const legacy = loadLegacySavedTabs();
  return restoreOpenTabsState(legacy.rawTabs, legacy.rawActiveTabId, {
    filter: restoreMode === "pinned" ? "pinned" : "all",
  });
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
  const tabs = ref<QueryTab[]>([]);
  const activeTabId = ref<string | null>(null);
  const isOpenTabsLoaded = ref(false);
  const activeTabHistory = ref<string[]>([]);
  const showCloseConfirm = ref(false);
  const pendingCloseTabId = ref<string | null>(null);
  const pendingBatchCloseTabIds = ref<string[] | null>(null);
  const pendingBatchCloseFinalActiveTabId = ref<string | null | undefined>(undefined);
  const isConfirmingAppClose = ref(false);
  const closeConfirmContext = ref<CloseConfirmContext>("tab");
  const tableStructureRefreshVersions = ref<Record<string, number>>({});
  const savedSqlEditorPositionTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

  async function closeClientSessionId(connectionId: string, database: string, clientSessionId: string, logContext: Record<string, unknown> = {}) {
    try {
      await api.closeClientConnectionSession(connectionId, database, clientSessionId);
    } catch (error) {
      console.warn("[DBX][client-session:close:error]", { ...logContext, clientSessionId, error });
    }
  }

  async function closeClientConnectionSession(tab: QueryTab | undefined) {
    if (!tab?.connectionId) return;
    const clientSessionIds = [tabClientSessionId(tab), ...BACKGROUND_CLIENT_SESSION_SUFFIXES.map((suffix) => tabClientSessionId(tab, suffix))];
    for (const clientSessionId of clientSessionIds) {
      await closeClientSessionId(tab.connectionId, tab.database, clientSessionId, { tabId: tab.id });
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
    tab.resultLocalSortOriginalRows = undefined;
    tab.resultSortMode = undefined;
    tab.resultSessionId = undefined;
    tab.resultAccessedAt = undefined;
    tab.queryAnalysis = undefined;
    tab.querySourceColumns = undefined;
    tab.queryEditabilityReason = undefined;
    tab.mongoEditTarget = undefined;
    if (tab.mode === "query") tab.tableMeta = undefined;
    tab.resultEvicted = options.evicted ? true : undefined;
    tab.resultCacheState = options.evicted ? tab.resultCacheState : undefined;
    if (!options.evicted) {
      if (tab.resultCacheKey) void deleteTabResultSnapshot(tab.resultCacheKey);
      tab.resultCacheKey = undefined;
    }
  }

  function clearResultRunSnapshots(tab: QueryTab) {
    for (const run of tab.resultRuns ?? []) {
      if (run.resultCacheKey) void deleteTabResultSnapshot(run.resultCacheKey);
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
    tab.resultSortMode = run.resultSortMode;
    tab.resultLocalSortOriginalRows = undefined;
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
    tab.mongoEditTarget = run.mongoEditTarget;
    tab.tableMeta = run.tableMeta;
    touchResult(tab);
  }

  async function restoreResultRunPayload(tab: QueryTab, runId: string) {
    const run = tab.resultRuns?.find((item) => item.id === runId);
    if (!run || run.result || run.results?.length) return run;

    const cacheKey = run.resultCacheKey ?? tab.resultCacheKey;
    if (!cacheKey) return run;

    const snapshot = await readTabResultSnapshot(cacheKey);
    const snapshotRun = snapshot?.resultRuns?.find((item) => item.id === runId);
    if (!snapshotRun) return run;

    const restoredRun = {
      ...run,
      ...snapshotRun,
      result: snapshotRun.result ? markQueryResultRowsRaw(snapshotRun.result) : undefined,
      results: snapshotRun.results ? markQueryResultsRowsRaw(snapshotRun.results) : undefined,
      resultCacheState: "memory" as const,
    };
    tab.resultRuns = tab.resultRuns?.map((item) => (item.id === runId ? restoredRun : item));
    return restoredRun;
  }

  async function setActiveResultRun(id: string, runId: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return false;
    const run = await restoreResultRunPayload(tab, runId);
    if (!run?.result && !run?.results?.length) return false;
    projectResultRun(tab, run);
    return true;
  }

  function removeResultRun(id: string, runId: string) {
    const tab = tabs.value.find((t) => t.id === id);
    const runIndex = tab?.resultRuns?.findIndex((run) => run.id === runId) ?? -1;
    if (!tab || !tab.resultRuns || runIndex < 0) return false;

    const removedRun = tab.resultRuns[runIndex];
    if (removedRun?.resultCacheKey) void deleteTabResultSnapshot(removedRun.resultCacheKey);
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

  function persistResultRun(tab: QueryTab, run: NonNullable<QueryTab["resultRuns"]>[number]) {
    const key = run.resultCacheKey ?? resultRunCacheKey(tab.id, run.id);
    run.resultCacheKey = key;
    run.resultCacheState = "memory";
    void writeTabResultSnapshot(key, {
      result: run.result,
      results: run.results,
      activeResultIndex: run.activeResultIndex,
      resultRuns: [run],
      activeResultRunId: run.id,
      queryAnalysis: run.queryAnalysis,
      querySourceColumns: run.querySourceColumns,
      queryEditabilityReason: run.queryEditabilityReason,
      tableMeta: run.tableMeta,
      resultPageSql: run.resultPageSql,
      resultPageLimit: run.resultPageLimit,
      resultPageOffset: run.resultPageOffset,
      resultCountSql: run.resultCountSql,
      resultTotalRowCount: run.resultTotalRowCount,
      cachedAt: Date.now(),
    });
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
      resultSortMode: tab.resultSortMode,
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
      mongoEditTarget: tab.mongoEditTarget,
      tableMeta: tab.tableMeta,
    };
    persistResultRun(tab, run);
    tab.resultRuns = [...(tab.resultRuns ?? []), run];
    tab.activeResultRunId = run.id;
  }

  function toggleResultAutoSave(id: string): boolean {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || tab.mode !== "query") return false;
    tab.resultAutoSave = tab.resultAutoSave ? undefined : true;
    if (tab.resultAutoSave && tab.result && !tab.activeResultRunId) {
      captureDisplayedResultRun(tab, tab.resultBaseSql ?? tab.lastExecutedSql ?? tab.sql);
    }
    return tab.resultAutoSave === true;
  }

  function syncActiveResultRunFromDisplayed(tab: QueryTab) {
    if (!tab.activeResultRunId || !tab.resultRuns?.length) return;
    const index = tab.resultRuns.findIndex((run) => run.id === tab.activeResultRunId);
    if (index < 0) return;
    const run = {
      ...tab.resultRuns[index],
      result: tab.result,
      results: tab.results,
      activeResultIndex: tab.activeResultIndex,
      resultBaseSql: tab.resultBaseSql,
      resultSortedSql: tab.resultSortedSql,
      resultSortColumn: tab.resultSortColumn,
      resultSortColumnIndex: tab.resultSortColumnIndex,
      resultSortDirection: tab.resultSortDirection,
      resultSortMode: tab.resultSortMode,
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
      mongoEditTarget: tab.mongoEditTarget,
      tableMeta: tab.tableMeta,
    };
    persistResultRun(tab, run);
    tab.resultRuns[index] = run;
  }

  function syncDisplayedResultRun(tab: QueryTab, sql: string) {
    if (tab.mode !== "query" || !tab.result) return;
    if (tab.activeResultRunId) {
      syncActiveResultRunFromDisplayed(tab);
    } else if (tab.resultAutoSave) {
      captureDisplayedResultRun(tab, sql);
    }
  }

  function assignDisplayedResult(tab: QueryTab, result: QueryResult) {
    tab.result = markQueryResultRowsRaw(result);
    if (tab.results?.length) {
      const activeIndex = tab.activeResultIndex ?? 0;
      if (activeIndex >= 0 && activeIndex < tab.results.length) {
        tab.results[activeIndex] = tab.result;
      }
    }
  }

  function sortTabResultLocally(id: string, column: string, columnIndex: number, direction: DataGridSortDirection | null) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab?.result) return;

    if (!tab.resultLocalSortOriginalRows) {
      tab.resultLocalSortOriginalRows = tab.result.rows.slice();
    }

    const rows = direction ? sortDataGridRows(tab.resultLocalSortOriginalRows, columnIndex, direction) : tab.resultLocalSortOriginalRows;
    assignDisplayedResult(tab, { ...tab.result, rows });

    tab.resultSortColumn = direction ? column : undefined;
    tab.resultSortColumnIndex = direction ? columnIndex : undefined;
    tab.resultSortDirection = direction ?? undefined;
    tab.resultSortMode = direction ? "local" : undefined;
    tab.resultSortedSql = undefined;
    if (!direction) tab.resultLocalSortOriginalRows = undefined;

    touchResult(tab);
    syncDisplayedResultRun(tab, tab.resultBaseSql ?? tab.lastExecutedSql ?? tab.sql);
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

  function applyRestoredOpenTabs(restored: { tabs: QueryTab[]; activeTabId: string | null }) {
    tabs.value = restored.tabs;
    activeTabId.value = restored.activeTabId;
    activeTabHistory.value = restored.activeTabId ? [restored.activeTabId] : [];
    for (const tab of restored.tabs) {
      if (tab.mode === "data") void deleteTabResultSnapshot(tabResultCacheKey(tab.id));
    }
  }

  async function initOpenTabs() {
    if (isOpenTabsLoaded.value) return;
    const saved = await api.loadOpenTabsState().catch(() => null);
    if (saved?.tabs && Array.isArray(saved.tabs)) {
      const restored = restoreSavedTabsFromPayload(saved);
      applyRestoredOpenTabs(restored);
      isOpenTabsLoaded.value = true;
      return;
    }

    const legacy = loadLegacySavedTabs();
    if (legacy.rawTabs || legacy.rawActiveTabId) {
      const restored = restoreLegacySavedTabs();
      applyRestoredOpenTabs(restored);
      if (useSettingsStore().editorSettings.openTabsRestoreMode === "none") {
        // Restore is explicitly disabled, so keeping the legacy startup payload
        // would resurrect old tabs if the user later changes the setting.
        clearLegacySavedTabs();
        isOpenTabsLoaded.value = true;
        return;
      }
      try {
        await saveTabs(tabs.value, activeTabId.value);
        // Keep old desktop installs readable until the async store has the
        // migrated state; only then remove the synchronous startup payload.
        clearLegacySavedTabs();
      } catch {
        /* keep legacy values for a later migration attempt */
      }
    }
    isOpenTabsLoaded.value = true;
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
      externalSqlPath: t.externalSqlPath,
      lastExecutedSql: t.lastExecutedSql,
      resultBaseSql: t.resultBaseSql,
      resultSortedSql: t.resultSortedSql,
      resultSortColumn: t.resultSortColumn,
      resultSortColumnIndex: t.resultSortColumnIndex,
      resultSortDirection: t.resultSortDirection,
      resultSortMode: t.resultSortMode,
      orderByInput: t.orderByInput,
      resultPageLimit: t.resultPageLimit,
      resultPageOffset: t.resultPageOffset,
      whereInput: t.whereInput,
      pinned: t.pinned,
      mode: t.mode,
      resultAutoSave: t.resultAutoSave,
      structureTableName: t.structureTableName,
      objectBrowser: t.objectBrowser,
      objectSource: t.objectSource,
      tableMeta: t.tableMeta,
      mongoEditTarget: t.mongoEditTarget,
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
        void saveTabs(tabs.value, activeTabId.value).catch(() => {});
        _persistTimer = null;
      }, 300);
    },
    { flush: "post" },
  );

  // Immediately flush any pending debounced persist so the on-disk content
  // reflects the latest in-memory tabs without waiting for the 300ms debounce.
  // Lets callers (e.g. tests that reload the store) read back persisted state
  // deterministically instead of racing the debounce timer.
  function flushPendingPersist(): Promise<void> {
    if (_persistTimer) {
      clearTimeout(_persistTimer);
      _persistTimer = null;
    }
    return saveTabs(tabs.value, activeTabId.value);
  }

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

  function openDamengJobAdmin(connectionId: string) {
    const existing = tabs.value.find((tab) => tab.mode === "dameng-jobs" && tab.connectionId === connectionId);
    if (existing) {
      activeTabId.value = existing.id;
      return existing.id;
    }

    const conn = useConnectionStore().getConfig(connectionId);
    const id = uuid();
    const tab: QueryTab = {
      id,
      title: t("damengJobAdmin.title"),
      connectionId,
      database: conn?.database || "",
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "dameng-jobs",
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function openMongoBucket(connectionId: string, database: string, bucketName: string) {
    const title = `${database}.${bucketName}`;
    const existing = tabs.value.find((tab) => tab.mode === "mongo-bucket" && tab.connectionId === connectionId && tab.database === database && tab.mongoBucket?.bucketName === bucketName);
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
      sql: bucketName,
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "mongo-bucket",
      mongoBucket: {
        bucketName,
      },
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function openMongoGridFs(connectionId: string, database: string) {
    const existing = tabs.value.find((tab) => tab.mode === "mongo-gridfs" && tab.connectionId === connectionId && tab.database === database);
    if (existing) {
      activeTabId.value = existing.id;
      return existing.id;
    }

    const id = uuid();
    const tab: QueryTab = {
      id,
      title: "GridFS",
      connectionId,
      database,
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "mongo-gridfs",
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function openMqAdmin(connectionId: string, target?: { tenant?: string; initialTab?: QueryTab["mqInitialTab"] }) {
    const existing = tabs.value.find((tab) => tab.mode === "mq" && tab.connectionId === connectionId);
    if (existing) {
      if (target?.tenant) existing.mqTenant = target.tenant;
      if (target?.initialTab) existing.mqInitialTab = target.initialTab;
      activeTabId.value = existing.id;
      return existing.id;
    }

    const conn = useConnectionStore().getConfig(connectionId);
    const id = uuid();
    const tab: QueryTab = {
      id,
      title: `${conn?.name || "Message Queue"} Admin`,
      connectionId,
      database: conn?.database || "",
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "mq",
      mqTenant: target?.tenant,
      mqInitialTab: target?.initialTab,
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function openNacosAdmin(connectionId: string, target?: { namespace?: string; namespaceName?: string }) {
    const namespace = target?.namespace ?? "";
    const namespaceName = target?.namespaceName || (namespace ? namespace : "public");
    const existing = tabs.value.find((tab) => tab.mode === "nacos" && tab.connectionId === connectionId && (tab.nacosNamespace || "") === namespace);
    if (existing) {
      existing.nacosNamespaceName = namespaceName;
      if (!existing.customTitle) existing.title = `${useConnectionStore().getConfig(connectionId)?.name || "Nacos"}:${namespaceName}`;
      activeTabId.value = existing.id;
      return existing.id;
    }

    const conn = useConnectionStore().getConfig(connectionId);
    const id = uuid();
    const tab: QueryTab = {
      id,
      title: `${conn?.name || "Nacos"}:${namespaceName}`,
      connectionId,
      database: conn?.database || "",
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "nacos",
      nacosNamespace: namespace,
      nacosNamespaceName: namespaceName,
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function applyTableStructureInitialTab(tab: QueryTab, initialTab?: TableInfoTab, initialTarget?: TableStructureEditorTarget) {
    if (!initialTab && !initialTarget?.name) return;
    if (initialTab) tab.structureInitialTab = initialTab;
    tab.structureInitialTarget = initialTarget?.name ? initialTarget : undefined;
    tab.structureInitialTabRequestId = (tab.structureInitialTabRequestId ?? 0) + 1;
  }

  function openTableStructure(connectionId: string, database: string, schema?: string, tableName?: string, initialTab?: TableInfoTab, initialTarget?: TableStructureEditorTarget) {
    const resolvedTableName = tableName || "";
    if (resolvedTableName) {
      const existing = tabs.value.find((tab) => tab.mode === "structure" && tab.connectionId === connectionId && tab.database === database && (tab.structureTableName || "") === resolvedTableName);
      if (existing) {
        applyTableStructureInitialTab(existing, initialTab, initialTarget);
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
      structureInitialTab: initialTab,
      structureInitialTabRequestId: initialTab || initialTarget?.name ? 1 : undefined,
      structureInitialTarget: initialTarget?.name ? initialTarget : undefined,
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function isTabDirty(tab: QueryTab): boolean {
    if (tab.mode !== "query") return false;
    if (!tab.externalSqlPath && !tab.sql.trim()) return false;
    const original = tab.originalSql;
    if (original === undefined) return !!tab.savedSqlId;
    return tab.sql !== original;
  }

  const hasDirtyTabs = computed(() => tabs.value.some((tab) => isTabDirty(tab)));
  const shouldConfirmUnsavedSqlClose = computed(() => useSettingsStore().editorSettings.confirmUnsavedSqlClose);

  const closeConfirmDirtyTabIds = computed(() => {
    if (isConfirmingAppClose.value) return tabs.value.filter((tab) => isTabDirty(tab)).map((tab) => tab.id);
    if (pendingBatchCloseTabIds.value) {
      return pendingBatchCloseTabIds.value
        .map((id) => tabs.value.find((tab) => tab.id === id))
        .filter((tab): tab is QueryTab => !!tab && isTabDirty(tab))
        .map((tab) => tab.id);
    }
    const pendingTab = pendingCloseTabId.value ? tabs.value.find((tab) => tab.id === pendingCloseTabId.value) : undefined;
    return pendingTab && isTabDirty(pendingTab) ? [pendingTab.id] : [];
  });

  function showDirtyTabCloseConfirm(tab: QueryTab, context: CloseConfirmContext) {
    pendingCloseTabId.value = tab.id;
    closeConfirmContext.value = context;
    activeTabId.value = tab.id;
    showCloseConfirm.value = true;
  }

  function markTabClean(tab: QueryTab | undefined) {
    if (tab) tab.originalSql = tab.sql;
  }

  function persistSavedSqlEditorPosition(tab: QueryTab | undefined) {
    if (!tab?.savedSqlId || tab.mode !== "query") return;
    const pending = savedSqlEditorPositionTimers.get(tab.savedSqlId);
    if (pending) {
      clearTimeout(pending);
      savedSqlEditorPositionTimers.delete(tab.savedSqlId);
    }
    saveSavedSqlEditorPosition(
      createSavedSqlEditorPosition({
        savedSqlId: tab.savedSqlId,
        sql: tab.sql,
        selection: tab.editorSelection,
        viewport: tab.editorViewport,
      }),
    );
  }

  function queueSavedSqlEditorPositionPersist(tab: QueryTab | undefined) {
    if (!tab?.savedSqlId || tab.mode !== "query") return;
    const pending = savedSqlEditorPositionTimers.get(tab.savedSqlId);
    if (pending) clearTimeout(pending);
    const tabId = tab.id;
    const savedSqlId = tab.savedSqlId;
    const timer = setTimeout(() => {
      savedSqlEditorPositionTimers.delete(savedSqlId);
      persistSavedSqlEditorPosition(tabs.value.find((item) => item.id === tabId));
    }, SAVED_SQL_EDITOR_POSITION_PERSIST_DELAY_MS);
    savedSqlEditorPositionTimers.set(savedSqlId, timer);
  }

  function discardTabChanges(id: string) {
    const tab = tabs.value.find((item) => item.id === id);
    if (!tab || tab.mode !== "query") return false;
    if (tab.originalSql !== undefined) {
      tab.sql = tab.originalSql;
      return true;
    }
    if (tab.savedSqlId) {
      tab.sql = "";
      return true;
    }
    tab.sql = "";
    tab.originalSql = "";
    return true;
  }

  function finishPendingBatchClose() {
    const finalActiveTabId = pendingBatchCloseFinalActiveTabId.value;
    pendingBatchCloseTabIds.value = null;
    pendingBatchCloseFinalActiveTabId.value = undefined;
    if (finalActiveTabId !== undefined) {
      activeTabId.value = finalActiveTabId && tabs.value.some((tab) => tab.id === finalActiveTabId) ? finalActiveTabId : null;
    }
  }

  function continuePendingBatchClose() {
    const pendingIds = pendingBatchCloseTabIds.value;
    if (!pendingIds) return;

    const remainingIds = pendingIds.filter((id) => tabs.value.some((tab) => tab.id === id));
    pendingBatchCloseTabIds.value = remainingIds;
    if (remainingIds.length === 0) {
      finishPendingBatchClose();
      return;
    }

    const dirtyTab = shouldConfirmUnsavedSqlClose.value ? remainingIds.map((id) => tabs.value.find((tab) => tab.id === id)).find((tab): tab is QueryTab => !!tab && isTabDirty(tab)) : undefined;
    if (dirtyTab) {
      // Batch close must pause before dropping dirty query tabs so the existing save/discard dialog can protect unsaved SQL.
      showDirtyTabCloseConfirm(dirtyTab, "batch");
      return;
    }

    finishPendingBatchClose();
    for (const id of remainingIds) closeTab(id, { force: true });
  }

  function beginBatchClose(ids: string[], finalActiveTabId?: string | null) {
    const uniqueIds = [...new Set(ids)].filter((id) => tabs.value.some((tab) => tab.id === id));
    if (uniqueIds.length === 0) return;
    pendingBatchCloseTabIds.value = uniqueIds;
    pendingBatchCloseFinalActiveTabId.value = finalActiveTabId;
    continuePendingBatchClose();
  }

  function resumePendingBatchCloseAfter(id: string) {
    const pendingIds = pendingBatchCloseTabIds.value;
    if (!pendingIds?.includes(id)) return;
    pendingBatchCloseTabIds.value = pendingIds.filter((pendingId) => pendingId !== id);
    continuePendingBatchClose();
  }

  function closeTab(id: string, { force = false }: { force?: boolean } = {}) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    if (!force && shouldConfirmUnsavedSqlClose.value && isTabDirty(tab)) {
      showDirtyTabCloseConfirm(tab, "tab");
      return;
    }
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx < 0) return;
    persistSavedSqlEditorPosition(tabs.value[idx]);
    clearDataGridPendingSnapshotsForTab(id);
    if (tabs.value[idx].txnSessionId) void rollbackTransaction(id);
    if (tabs.value[idx].isExecuting) void cancelTabExecution(id);
    if (tabs.value[idx].isExplaining) void cancelTabExplain(id);
    void closeResultSession(tabs.value[idx]);
    void closeClientConnectionSession(tabs.value[idx]);
    clearResultRunSnapshots(tabs.value[idx]);
    clearResultPayload(tabs.value[idx]);
    tabs.value.splice(idx, 1);
    if (activeTabId.value === id) {
      activeTabId.value = fallbackActiveTabAfterClose(id, idx);
    }
    if (force) resumePendingBatchCloseAfter(id);
  }

  function forceClosePendingTab() {
    const id = pendingCloseTabId.value;
    const confirmingAppClose = isConfirmingAppClose.value;
    pendingCloseTabId.value = null;
    showCloseConfirm.value = false;
    closeConfirmContext.value = "tab";
    if (confirmingAppClose) {
      if (id) discardTabChanges(id);
      isConfirmingAppClose.value = false;
      return;
    }
    if (id) closeTab(id, { force: true });
  }

  function forceCloseAllPendingTabs() {
    const dirtyIds = closeConfirmDirtyTabIds.value;
    const pendingId = pendingCloseTabId.value;
    const batchIds = pendingBatchCloseTabIds.value?.filter((id) => tabs.value.some((tab) => tab.id === id)) ?? null;
    const finalActiveTabId = pendingBatchCloseFinalActiveTabId.value;
    const confirmingAppClose = isConfirmingAppClose.value;

    pendingCloseTabId.value = null;
    showCloseConfirm.value = false;
    pendingBatchCloseTabIds.value = null;
    pendingBatchCloseFinalActiveTabId.value = undefined;
    isConfirmingAppClose.value = false;
    closeConfirmContext.value = "tab";

    for (const id of dirtyIds) discardTabChanges(id);
    if (confirmingAppClose) return;

    const idsToClose = batchIds ?? (pendingId ? [pendingId] : []);
    for (const id of idsToClose) closeTab(id, { force: true });
    if (finalActiveTabId !== undefined) {
      activeTabId.value = finalActiveTabId && tabs.value.some((tab) => tab.id === finalActiveTabId) ? finalActiveTabId : null;
    }
  }

  function cancelClosePendingTab() {
    pendingCloseTabId.value = null;
    showCloseConfirm.value = false;
    pendingBatchCloseTabIds.value = null;
    pendingBatchCloseFinalActiveTabId.value = undefined;
    isConfirmingAppClose.value = false;
    closeConfirmContext.value = "tab";
  }

  function saveAndClosePendingTab() {
    const id = pendingCloseTabId.value;
    pendingCloseTabId.value = null;
    showCloseConfirm.value = false;
    isConfirmingAppClose.value = false;
    closeConfirmContext.value = "tab";
    if (id) return id;
    return null;
  }

  function suspendCloseConfirm() {
    showCloseConfirm.value = false;
  }

  function resumeCloseConfirm() {
    const dirtyId = closeConfirmDirtyTabIds.value[0];
    const dirtyTab = dirtyId ? tabs.value.find((tab) => tab.id === dirtyId) : undefined;
    if (!dirtyTab) return false;
    pendingCloseTabId.value = dirtyTab.id;
    activeTabId.value = dirtyTab.id;
    showCloseConfirm.value = true;
    return true;
  }

  function completePendingCloseAfterSaveAll() {
    const pendingId = pendingCloseTabId.value;
    const batchIds = pendingBatchCloseTabIds.value?.filter((id) => tabs.value.some((tab) => tab.id === id)) ?? null;
    const finalActiveTabId = pendingBatchCloseFinalActiveTabId.value;
    const confirmingAppClose = isConfirmingAppClose.value;

    pendingCloseTabId.value = null;
    showCloseConfirm.value = false;
    pendingBatchCloseTabIds.value = null;
    pendingBatchCloseFinalActiveTabId.value = undefined;
    isConfirmingAppClose.value = false;
    closeConfirmContext.value = "tab";

    if (confirmingAppClose) return "app" as const;

    const idsToClose = batchIds ?? (pendingId ? [pendingId] : []);
    for (const id of idsToClose) closeTab(id, { force: true });
    if (finalActiveTabId !== undefined) {
      activeTabId.value = finalActiveTabId && tabs.value.some((tab) => tab.id === finalActiveTabId) ? finalActiveTabId : null;
    }
    return "tabs" as const;
  }

  function closeOtherTabs(id: string) {
    if (!tabs.value.some((tab) => tab.id === id)) return;
    beginBatchClose(
      tabs.value.filter((tab) => tab.id !== id).map((tab) => tab.id),
      id,
    );
  }

  function finalActiveTabAfterClosing(ids: string[]) {
    const closingIds = new Set(ids);
    const activeTab = activeTabId.value ? tabs.value.find((tab) => tab.id === activeTabId.value) : undefined;
    if (activeTab && !closingIds.has(activeTab.id)) return activeTab.id;
    return tabs.value.find((tab) => !closingIds.has(tab.id))?.id ?? null;
  }

  function closeOtherRegularTabs(id: string) {
    const tab = tabs.value.find((item) => item.id === id);
    if (!tab || tab.pinned) return;
    beginBatchClose(
      tabs.value.filter((item) => !item.pinned && item.id !== id).map((item) => item.id),
      id,
    );
  }

  function closeRegularTabs() {
    const ids = tabs.value.filter((tab) => !tab.pinned).map((tab) => tab.id);
    beginBatchClose(ids, finalActiveTabAfterClosing(ids));
  }

  function closeOtherFixedTabs(id: string) {
    const tab = tabs.value.find((item) => item.id === id);
    if (!tab || !tab.pinned) return;
    beginBatchClose(
      tabs.value.filter((item) => item.pinned && item.id !== id).map((item) => item.id),
      id,
    );
  }

  function closeFixedTabs() {
    const ids = tabs.value.filter((tab) => tab.pinned).map((tab) => tab.id);
    beginBatchClose(ids, finalActiveTabAfterClosing(ids));
  }

  function closeAllTabs() {
    beginBatchClose(
      tabs.value.map((tab) => tab.id),
      null,
    );
  }

  function requestAppCloseConfirmation() {
    if (!shouldConfirmUnsavedSqlClose.value) return false;
    const dirtyTab = tabs.value.find((tab) => isTabDirty(tab));
    if (!dirtyTab) return false;
    isConfirmingAppClose.value = true;
    showDirtyTabCloseConfirm(dirtyTab, "app");
    return true;
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
      resultSortMode: undefined,
      resultLocalSortOriginalRows: undefined,
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
      mqTenant: original.mqTenant,
      mqInitialTab: original.mqInitialTab,
      nacosNamespace: original.nacosNamespace,
      nacosNamespaceName: original.nacosNamespaceName,
      structureTableName: original.structureTableName,
      structureDraft: original.structureDraft ? cloneTabDraft(original.structureDraft) : undefined,
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
        if (tab.txnSessionId) void rollbackTransaction(tab.id);
        if (tab.isExecuting) void cancelTabExecution(tab.id);
        if (tab.isExplaining) void cancelTabExplain(tab.id);
        void closeResultSession(tab);
        void closeClientConnectionSession(tab);
        clearResultRunSnapshots(tab);
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

  function tabMatchesDroppedTableObject(tab: QueryTab, target: DroppedTableObjectTarget): boolean {
    if (tab.connectionId !== target.connectionId || tab.database !== target.database) return false;
    const targetSchemas = droppedTableObjectSchemaCandidates(target);

    if (tab.mode === "data") {
      const tableMeta = tableMetaForDataTab(tab);
      if (!tableMeta || tableMeta.tableName !== target.name) return false;
      return targetSchemas.has(normalizeOptionalSchema(tableMeta.schema ?? tab.schema));
    }

    if ((target.objectType ?? "TABLE") === "TABLE" && tab.mode === "structure") {
      if ((tab.structureTableName || "") !== target.name) return false;
      return targetSchemas.has(normalizeOptionalSchema(tab.schema));
    }

    return false;
  }

  function closeDroppedTableObjectTabs(target: DroppedTableObjectTarget) {
    // A dropped table-like object makes existing data/structure tabs stale; close
    // them immediately instead of letting the next refresh fail against a missing object.
    closeTabsWhere((tab) => tabMatchesDroppedTableObject(tab, target));
  }

  function releaseTabsWhere(predicate: (tab: QueryTab) => boolean) {
    closeTabsWhere((tab) => predicate(tab) && tab.mode !== "query");
    tabs.value
      .filter((tab) => predicate(tab))
      .forEach((tab) => {
        rollbackTabTransaction(tab, { resetAutoCommit: true });
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

  function isDatabaseOpen(connectionId: string, database: string) {
    return tabs.value.some((tab) => tab.connectionId === connectionId && tab.database === database);
  }

  function rollbackTabsWhere(predicate: (tab: QueryTab) => boolean, options?: { resetAutoCommit?: boolean }) {
    tabs.value.filter((tab) => predicate(tab)).forEach((tab) => rollbackTabTransaction(tab, options));
  }

  function rollbackConnectionTransactions(connectionId: string) {
    rollbackTabsWhere((tab) => tab.connectionId === connectionId, { resetAutoCommit: true });
  }

  function rollbackDatabaseTransactions(connectionId: string, database: string) {
    rollbackTabsWhere((tab) => tab.connectionId === connectionId && tab.database === database, { resetAutoCommit: true });
  }

  function updateSql(id: string, sql: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (tab) {
      tab.sql = sql;
      queueSavedSqlEditorPositionPersist(tab);
    }
  }

  function setAutoCommit(id: string, autoCommit: boolean) {
    const tab = tabs.value.find((t) => t.id === id);
    if (tab) {
      const wasManual = tab.autoCommit === false;
      tab.autoCommit = autoCommit;
      if (autoCommit && wasManual) {
        if (tab.txnSessionId) {
          void rollbackTransaction(id);
        } else {
          tab.txnAutoRolledBack = false;
        }
      }
    }
  }

  function rollbackTabTransaction(tab: QueryTab, options?: { resetAutoCommit?: boolean }) {
    if (tab.txnSessionId) void rollbackTransaction(tab.id);
    if (options?.resetAutoCommit) tab.autoCommit = true;
    tab.txnAutoRolledBack = false;
  }

  async function commitTransaction(id: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab?.txnSessionId) return;
    try {
      await api.commitManualTransaction(tab.txnSessionId);
    } finally {
      tab.txnSessionId = undefined;
      tab.txnAutoRolledBack = false;
    }
  }

  async function rollbackTransaction(id: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab?.txnSessionId) return;
    try {
      await api.rollbackManualTransaction(tab.txnSessionId);
    } finally {
      tab.txnSessionId = undefined;
      tab.txnAutoRolledBack = false;
    }
  }

  function updateEditorViewport(id: string, viewport: { scrollTop: number; scrollLeft: number }) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    tab.editorViewport = viewport;
    queueSavedSqlEditorPositionPersist(tab);
  }

  function updateEditorSelection(id: string, selection: { anchor: number; head: number }) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    tab.editorSelection = selection;
    queueSavedSqlEditorPositionPersist(tab);
  }

  function renameTab(id: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return false;
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || tab.mode !== "query") return false;
    const normalizedTitle = tab.savedSqlId ? ensureSqlExtension(trimmed) : trimmed;
    const previousTitle = tab.title;
    tab.title = normalizedTitle;
    tab.customTitle = true;
    if (tab.savedSqlId) {
      const savedSqlStore = useSavedSqlStore();
      const existing = savedSqlStore.getFile(tab.savedSqlId);
      if (existing && existing.name !== normalizedTitle) {
        void savedSqlStore.renameFile(tab.savedSqlId, normalizedTitle).catch((error) => {
          console.warn("[DBX][saved-sql:rename:error]", error);
          tab.title = previousTitle;
        });
      }
    }
    return true;
  }

  function linkSavedSql(id: string, savedSqlId: string, title?: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    tab.savedSqlId = savedSqlId;
    tab.externalSqlPath = undefined;
    if (title) {
      tab.title = title;
      tab.customTitle = true;
    }
  }

  function linkExternalSqlPath(id: string, path: string, title?: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    tab.externalSqlPath = path;
    tab.savedSqlId = undefined;
    if (title) {
      tab.title = title;
      tab.customTitle = true;
    }
    markTabClean(tab);
  }

  function openSavedSql(file: SavedSqlFile) {
    const existing = tabs.value.find((tab) => tab.savedSqlId === file.id);
    if (existing) {
      persistSavedSqlEditorPosition(existing);
      if (!existing.sql && file.sql) {
        existing.sql = file.sql;
        existing.originalSql = file.sql;
        const restored = restoreSavedSqlEditorPosition(file.id, file.sql);
        existing.editorSelection = restored.selection;
        existing.editorViewport = restored.viewport;
      }
      activeTabId.value = existing.id;
      return existing.id;
    }

    const id = uuid();
    const restoredPosition = restoreSavedSqlEditorPosition(file.id, file.sql);
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
      editorSelection: restoredPosition.selection,
      editorViewport: restoredPosition.viewport,
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  async function hydrateSavedSqlTabs() {
    await initSavedSqlEditorPositions();
    const savedSqlStore = useSavedSqlStore();
    const linkedTabs = tabs.value.filter((tab) => tab.savedSqlId && tab.sql === "");
    for (const tab of linkedTabs) {
      const file = await savedSqlStore.ensureFileContent(tab.savedSqlId!);
      if (!file) continue;
      tab.title = tab.customTitle ? tab.title : file.name;
      tab.connectionId = file.connectionId;
      tab.database = file.database;
      tab.schema = file.schema;
      tab.sql = file.sql;
      tab.originalSql = file.sql;
      const restored = restoreSavedSqlEditorPosition(file.id, file.sql);
      tab.editorSelection = restored.selection;
      tab.editorViewport = restored.viewport;
    }
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
    rollbackTabTransaction(tab);
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
    rollbackTabTransaction(tab);
    tab.schema = schema;
    if (tab.mode === "objects") tab.objectBrowser = { ...tab.objectBrowser, schema };
  }

  function updateConnection(id: string, connectionId: string, database = "") {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || tab.connectionId === connectionId) return;
    rollbackTabTransaction(tab, { resetAutoCommit: true });
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

    // Sync connection change back to the saved SQL file if this tab is linked
    if (tab.savedSqlId) {
      const savedSqlStore = useSavedSqlStore();
      void savedSqlStore.ensureFileContent(tab.savedSqlId).then((existing) => {
        if (!existing) return;
        return savedSqlStore.saveFile({
          id: existing.id,
          connectionId,
          name: existing.name,
          database,
          schema: existing.schema,
          sql: existing.sql,
        });
      });
    }
  }

  function setTableMeta(id: string, meta: NonNullable<QueryTab["tableMeta"]>) {
    const tab = tabs.value.find((t) => t.id === id);
    if (tab) {
      tab.tableMeta = meta;
      tab.tableMetaUpdatedAt = Date.now();
    }
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

  function clearAcknowledgedCancelIfStillRunning(id: string, executionId: string) {
    setTimeout(() => {
      const current = tabs.value.find((t) => t.id === id);
      if (!current || current.executionId !== executionId || !current.isCancelling) return;
      current.isExecuting = false;
      current.isCancelling = false;
      current.executionId = undefined;
      current.queryExecutionStartedAt = undefined;
      current.result = toErrorResult(new Error("Query canceled"));
      current.results = undefined;
      current.activeResultIndex = undefined;
      current.resultSessionId = undefined;
      touchResult(current);
    }, CANCEL_ACK_SETTLE_TIMEOUT_MS);
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
    tab.mongoEditTarget = undefined;
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
    const resolvedSchema = metadataSchemaForConnection(conn, tab.database, schema || undefined);
    const metadataSchema = normalizeOracleLikeMetadataIdentifier(dbType, resolvedSchema || undefined, analysis.schema ? analysis.schemaQuoted : false) || "";
    const metadataTableName = normalizeOracleLikeMetadataIdentifier(dbType, analysis.tableName, analysis.tableNameQuoted)!;
    const metadataAnalysis = normalizeOracleLikeQueryAnalysis(dbType, analysis, metadataSchema || undefined, metadataTableName);

    try {
      console.info("[DBX][executeTabSql:metadata:table:start]", {
        traceId,
        schema: metadataSchema,
        table: metadataTableName,
        elapsed: elapsed?.(),
      });
      const loadedMetadata = await loadTableMetadata({
        connectionId: tab.connectionId,
        database: tab.database,
        schema: metadataSchema,
        tableName: metadataTableName,
        tableType: tab.tableMeta?.tableType,
        databaseType: dbType,
        driverProfile: conn?.driver_profile || conn?.db_type,
        traceLogger: (event) => console.debug("[DBX][executeTabSql:metadata:table-trace]", { sourceTraceId: traceId, ...event }),
      });
      const columns = loadedMetadata.metadata.columns;
      const primaryKeys = loadedMetadata.metadata.primaryKeys;
      console.info("[DBX][executeTabSql:metadata:table:done]", {
        traceId,
        columnCount: columns.length,
        primaryKeyCount: primaryKeys.length,
        cacheStatus: loadedMetadata.cacheStatus,
        ageMs: Math.round(loadedMetadata.ageMs),
        elapsed: elapsed?.(),
      });
      const tableType = loadedMetadata.metadata.tableType;
      const tableMeta = {
        schema: metadataSchema || undefined,
        tableName: metadataTableName,
        tableType,
        columns,
        primaryKeys,
      };

      if (primaryKeys.length === 0 && !canUseKeylessRowPredicate(dbType as DatabaseType, primaryKeys)) {
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
    const clientSessionId = tabClientSessionId({ id: options.tabId }, "count");
    const countExecutionId = `${options.executionId}:count`;

    if (typeof options.pageLimit === "number" && resultRowCount < options.pageLimit) {
      setQueryTotalRowCountIfCurrent(options.tabId, options.executionId, options.result, (options.pageOffset ?? 0) + resultRowCount);
      return;
    }

    void (async () => {
      try {
        console.info("[DBX][executeTabSql:count:start]", { traceId: options.traceId, elapsed: options.elapsed() });
        const countResult = await api.executeQuery(options.connectionId, options.database, countSql, options.schema, countExecutionId, {
          clientSessionId,
          timeoutSecs: options.timeoutSecs,
        });
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
      } finally {
        void closeClientSessionId(options.connectionId, options.database, clientSessionId, { tabId: options.tabId });
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
      sourceTraceId?: string;
      skipEnsureConnected?: boolean;
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
    tab.resultLocalSortOriginalRows = undefined;
    const updateActiveResultRun = !!tab.activeResultRunId && options?.preserveResultDuringExecution === true;
    if (!updateActiveResultRun) {
      tab.activeResultRunId = undefined;
    }
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
      sourceTraceId: options?.sourceTraceId,
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
      let conn = connStore.getConfig(tab.connectionId);
      const parsedMongoCommands = conn?.db_type === "mongodb" ? splitMongoCommandRanges(sql) : undefined;
      let mongoCommands = parsedMongoCommands ?? [];
      const mongoNeedsConnection = mongoCommands.some(({ command }) => command.kind !== "use");

      if (options?.skipEnsureConnected) {
        console.info("[DBX][executeTabSql:ensure-connected:skip]", { traceId, elapsed: elapsed(), reason: "caller" });
      } else if (conn?.db_type === "mongodb" && mongoCommands.length > 0 && !mongoNeedsConnection) {
        console.info("[DBX][executeTabSql:ensure-connected:skip]", { traceId, elapsed: elapsed(), reason: "mongo-use-only" });
      } else {
        console.info("[DBX][executeTabSql:ensure-connected:start]", { traceId, elapsed: elapsed() });
        await connStore.ensureConnected(tab.connectionId);
        console.info("[DBX][executeTabSql:ensure-connected:done]", { traceId, elapsed: elapsed() });
      }
      conn = connStore.getConfig(tab.connectionId);
      if (parsedMongoCommands === undefined && conn?.db_type === "mongodb") {
        mongoCommands = splitMongoCommandRanges(sql);
      }
      const effectiveDbType = effectiveDatabaseTypeForConnection(conn);
      const useAgentCursor = usesAgentCursorForQuery(conn?.db_type);
      const queryTimeoutSecs = queryTimeoutSecsForConnection(conn);
      const settingsStore = useSettingsStore();
      console.info("[DBX][executeTabSql:previous-session-close:start]", { traceId, elapsed: elapsed() });
      await previousResultSessionClose;
      console.info("[DBX][executeTabSql:previous-session-close:done]", { traceId, elapsed: elapsed() });

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
        let hadMutatingCommand = false;
        for (const command of commands) {
          try {
            const result = await api.redisExecuteCommand(tab.connectionId, currentDb, command, skipSafety);
            allResults.push(markQueryResultRowsRaw(annotateQueryResultSource(redisCommandResultToQueryResult(result.value, performance.now() - startedAt, result.command), command)));
            // Track db switches from SELECT N so later commands in the same batch run on the right db.
            currentDb = nextRedisCommandDb(currentDb, command, result.value);
            // Write commands (SET/DEL/...) mutate the key set — drop the cached key-name completion
            // for the db this command ran on so the next autocomplete fetch reflects the new keys.
            if (isRedisMutatingCommand(command)) {
              hadMutatingCommand = true;
              connStore.invalidateCompletionCache(tab.connectionId, String(currentDb));
            }
          } catch (e: any) {
            allResults.push(annotateQueryResultSource({ columns: ["Error"], rows: [[e?.message ?? String(e)]], affected_rows: 0, execution_time_ms: 0 }, command));
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
          current.mongoEditTarget = undefined;
          current.tableMeta = undefined;
          current.resultBaseSql = options?.resultBaseSql ?? sql;
          current.resultSortedSql = options?.resultSortedSql;
          syncDisplayedResultRun(current, options?.resultBaseSql ?? sql);
          // Reflect db switches from SELECT N in the tab so the toolbar dropdown, tab title and
          // sidebar stay in sync with the command's effective db.
          if (current.database !== String(currentDb)) {
            current.database = String(currentDb);
          }
        }
        // Refresh the sidebar db key counts (INFO keyspace) when at least one command in
        // this batch mutated the key set, so `dbN (count)` stays accurate without a manual
        // refresh. Fire-and-forget: never block result display.
        if (hadMutatingCommand) {
          void connStore.refreshRedisDbKeyCounts(tab.connectionId);
        }
        return;
      }

      if (mongoCommands.length > 0) {
        console.info("[DBX][executeTabSql:mongo:start]", { traceId, database: tab.database, commandCount: mongoCommands.length, sql });

        const allResults: QueryResult[] = [];
        // Track the effective db as we walk the batch so later commands observe
        // earlier `use ...` statements in the same editor selection.
        let currentDatabase = tab.database;
        let mongoEditTarget: QueryTab["mongoEditTarget"] | undefined;

        for (const parsedCommand of mongoCommands) {
          const mongoCommand = parsedCommand.command;
          const sourceStatement = parsedCommand.text;
          const commandStartedAt = performance.now();
          try {
            switch (mongoCommand.kind) {
              case "find": {
                console.info("[DBX][executeTabSql:mongo-find:start]", { traceId, collection: mongoCommand.collection, database: currentDatabase });
                const result = await api.mongoFindDocuments(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.skip, mongoCommand.limit, mongoCommand.filter, mongoCommand.projection, mongoCommand.sort, executionId);
                const queryResult = markQueryResultRowsRaw(annotateQueryResultSource(mongoDocumentsToQueryResult(result.documents, performance.now() - commandStartedAt, result.total), sourceStatement));
                allResults.push(queryResult);
                mongoEditTarget = mongoCommands.length === 1 && queryResult.columns.includes("_id") ? { collection: mongoCommand.collection, idColumn: "_id" } : undefined;
                console.info("[DBX][executeTabSql:mongo-find:done]", {
                  traceId,
                  collection: mongoCommand.collection,
                  database: currentDatabase,
                  rowCount: result.documents.length,
                  total: result.total,
                  elapsed: elapsed(),
                });
                break;
              }
              case "version": {
                console.info("[DBX][executeTabSql:mongo-version:start]", { traceId, database: currentDatabase });
                const version = await api.mongoServerVersion(tab.connectionId, currentDatabase, executionId);
                allResults.push(markQueryResultRowsRaw(annotateQueryResultSource(mongoVersionToQueryResult(version, performance.now() - commandStartedAt), sourceStatement)));
                mongoEditTarget = undefined;
                console.info("[DBX][executeTabSql:mongo-version:done]", {
                  traceId,
                  database: currentDatabase,
                  version,
                  elapsed: elapsed(),
                });
                break;
              }
              case "countDocuments": {
                console.info("[DBX][executeTabSql:mongo-count:start]", { traceId, collection: mongoCommand.collection, database: currentDatabase });
                const result = await api.mongoFindDocuments(tab.connectionId, currentDatabase, mongoCommand.collection, 0, 1, mongoCommand.filter, undefined, undefined, executionId);
                allResults.push(markQueryResultRowsRaw(annotateQueryResultSource(mongoCountToQueryResult(result.total, performance.now() - commandStartedAt), sourceStatement)));
                mongoEditTarget = undefined;
                console.info("[DBX][executeTabSql:mongo-count:done]", {
                  traceId,
                  collection: mongoCommand.collection,
                  database: currentDatabase,
                  total: result.total,
                  elapsed: elapsed(),
                });
                break;
              }
              case "aggregate": {
                if (options?.mongoSafety) {
                  const safety = evaluateMongoAggregateSafety(mongoCommand, options.mongoSafety);
                  if (!safety.allowed) throw new Error(safety.reason);
                }
                console.info("[DBX][executeTabSql:mongo-aggregate:start]", { traceId, collection: mongoCommand.collection, database: currentDatabase });
                const aggregateMaxRows = normalizeResultPageSize(pageLimit ?? options?.pagination?.limit ?? settingsStore.editorSettings.pageSize);
                const result = await api.mongoAggregateDocuments(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.pipeline, aggregateMaxRows, executionId);
                allResults.push(markQueryResultRowsRaw(annotateQueryResultSource(mongoDocumentsToQueryResult(result.documents, performance.now() - commandStartedAt, result.total), sourceStatement)));
                mongoEditTarget = undefined;
                console.info("[DBX][executeTabSql:mongo-aggregate:done]", {
                  traceId,
                  collection: mongoCommand.collection,
                  database: currentDatabase,
                  rowCount: result.documents.length,
                  total: result.total,
                  elapsed: elapsed(),
                });
                break;
              }
              case "getIndexes": {
                console.info("[DBX][executeTabSql:mongo-indexes:start]", { traceId, collection: mongoCommand.collection, database: currentDatabase });
                const indexes = await api.listIndexes(tab.connectionId, currentDatabase, "", mongoCommand.collection);
                allResults.push(markQueryResultRowsRaw(annotateQueryResultSource(mongoIndexesToQueryResult(indexes, performance.now() - commandStartedAt), sourceStatement)));
                mongoEditTarget = undefined;
                console.info("[DBX][executeTabSql:mongo-indexes:done]", {
                  traceId,
                  collection: mongoCommand.collection,
                  database: currentDatabase,
                  indexCount: indexes.length,
                  elapsed: elapsed(),
                });
                break;
              }
              case "collectionStats": {
                console.info("[DBX][executeTabSql:mongo-collection-stats:start]", {
                  traceId,
                  collection: mongoCommand.collection,
                  metric: mongoCommand.metric,
                  database: currentDatabase,
                });
                const stats = await api.mongoCollectionStats(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.scale, executionId);
                allResults.push(markQueryResultRowsRaw(annotateQueryResultSource(mongoCollectionStatsToQueryResult(mongoCommand.metric, stats as unknown as Record<string, unknown>, performance.now() - commandStartedAt), sourceStatement)));
                mongoEditTarget = undefined;
                console.info("[DBX][executeTabSql:mongo-collection-stats:done]", {
                  traceId,
                  collection: mongoCommand.collection,
                  metric: mongoCommand.metric,
                  database: currentDatabase,
                  elapsed: elapsed(),
                });
                break;
              }
              case "insert":
              case "update":
              case "delete":
              case "createIndex":
              case "dropIndex":
              case "dropIndexes": {
                if (options?.mongoSafety) {
                  const safety = evaluateMongoWriteSafety(mongoCommand, options.mongoSafety);
                  if (!safety.allowed) throw new Error(safety.reason);
                }
                console.info("[DBX][executeTabSql:mongo-write:start]", {
                  traceId,
                  database: currentDatabase,
                  kind: mongoCommand.kind,
                  collection: mongoCommand.collection,
                });
                mongoEditTarget = undefined;
                if (mongoCommand.kind === "insert") {
                  const result = await api.mongoInsertDocuments(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.docsJson);
                  allResults.push(markQueryResultRowsRaw(annotateQueryResultSource(mongoWriteToQueryResult(result.affected_rows, performance.now() - commandStartedAt), sourceStatement)));
                } else if (mongoCommand.kind === "update") {
                  const result = await api.mongoUpdateDocuments(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.filter, mongoCommand.update, mongoCommand.many);
                  allResults.push(markQueryResultRowsRaw(annotateQueryResultSource(mongoWriteToQueryResult(result.affected_rows, performance.now() - commandStartedAt), sourceStatement)));
                } else if (mongoCommand.kind === "createIndex") {
                  const result = await api.mongoCreateIndex(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.keys, mongoCommand.options);
                  allResults.push(markQueryResultRowsRaw(annotateQueryResultSource(mongoCreateIndexToQueryResult(result.name, performance.now() - commandStartedAt), sourceStatement)));
                } else if (mongoCommand.kind === "dropIndex" || mongoCommand.kind === "dropIndexes") {
                  const result = await api.mongoDropIndexes(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.kind === "dropIndex" ? mongoCommand.index : mongoCommand.indexes, mongoCommand.kind === "dropIndex");
                  allResults.push(markQueryResultRowsRaw(annotateQueryResultSource(mongoDroppedIndexesToQueryResult(result.dropped_names, performance.now() - commandStartedAt), sourceStatement)));
                } else {
                  const result = await api.mongoDeleteDocuments(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.filter, mongoCommand.many);
                  allResults.push(markQueryResultRowsRaw(annotateQueryResultSource(mongoWriteToQueryResult(result.affected_rows, performance.now() - commandStartedAt), sourceStatement)));
                }
                console.info("[DBX][executeTabSql:mongo-write:done]", {
                  traceId,
                  database: currentDatabase,
                  kind: mongoCommand.kind,
                  collection: mongoCommand.collection,
                  elapsed: elapsed(),
                });
                break;
              }
              case "use": {
                currentDatabase = mongoCommand.database;
                allResults.push(markQueryResultRowsRaw(annotateQueryResultSource(mongoUseToQueryResult(currentDatabase, performance.now() - commandStartedAt), sourceStatement)));
                mongoEditTarget = undefined;
                console.info("[DBX][executeTabSql:mongo-use:done]", {
                  traceId,
                  database: currentDatabase,
                  elapsed: elapsed(),
                });
                break;
              }
            }
          } catch (error: any) {
            // Surface per-command failures inline and continue collecting results
            // for the rest of the batch, matching the grouped-result UX.
            allResults.push(annotateQueryResultSource(toErrorResult(error), sourceStatement));
            mongoEditTarget = undefined;
          }
        }

        console.info("[DBX][executeTabSql:mongo:done]", {
          traceId,
          database: currentDatabase,
          commandCount: mongoCommands.length,
          elapsed: elapsed(),
        });

        const current = tabs.value.find((t) => t.id === id);
        if (current?.executionId === executionId) {
          if (allResults.length > 1) {
            // Open grouped output on the first non-error result when possible so
            // mixed success/error batches land on the most useful table first.
            const activeResultIndex = allResults.findIndex((result) => !result.columns.includes("Error"));
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
          current.mongoEditTarget = mongoCommands.length === 1 ? mongoEditTarget : undefined;
          current.tableMeta = undefined;
          current.resultBaseSql = options?.resultBaseSql ?? sql;
          current.resultSortedSql = options?.resultSortedSql;
          syncDisplayedResultRun(current, options?.resultBaseSql ?? sql);
          if (current.database !== currentDatabase) current.database = currentDatabase;
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
        pageLimit = options?.pagination?.limit ?? tableOpenPageLimit(settingsStore.editorSettings.pageSize);
        pageOffset = options?.pagination?.offset ?? 0;
      }

      const executionSchema = connectionUsesSchemaExecutionContext(conn) ? tab.schema || tab.database : tab.mode === "data" || connectionUsesDatabaseObjectTreeMode(conn) ? undefined : tab.schema;
      const frontendTimeoutSecs = frontendQueryTimeoutSecsForSql(sqlToExecute, effectiveDbType, queryTimeoutSecs);
      const sourceLabelDatabase = tab.database || conn?.database;

      let executionPromise: Promise<QueryResult[]>;
      if (tab.autoCommit === false) {
        if (!tab.txnSessionId) {
          console.info("[DBX][executeTabSql:begin-manual-txn:start]", { traceId, elapsed: elapsed() });
          tab.txnSessionId = await api.beginManualTransaction(tab.connectionId, tab.database, executionSchema);
          console.info("[DBX][executeTabSql:begin-manual-txn:done]", { traceId, txnSessionId: tab.txnSessionId, elapsed: elapsed() });
        }
        console.info("[DBX][executeTabSql:execute-in-txn:invoke]", { traceId, txnSessionId: tab.txnSessionId, elapsed: elapsed() });
        executionPromise = api.executeInManualTransaction(tab.txnSessionId, sqlToExecute, tab.database, executionSchema, pageLimit);
      } else {
        console.info("[DBX][executeTabSql:execute-multi:start]", { traceId, elapsed: elapsed() });
        // Data tabs should reuse the already-open pool; session pools are reserved
        // for query tabs/background tasks that need connection-local state isolation.
        const clientSessionId = tab.mode === "query" ? tabClientSessionId(tab) : undefined;
        const executionOptions = {
          ...(typeof pageLimit === "number"
            ? useAgentResultSession
              ? {
                  fetchSize: pageLimit,
                  pageSize: pageLimit,
                  resultSessionId: options?.pagination?.sessionId,
                }
              : { maxRows: pageLimit, fetchSize: pageLimit }
            : {}),
          ...(clientSessionId ? { clientSessionId } : {}),
          timeoutSecs: queryTimeoutSecs,
        };
        console.info("[DBX][executeTabSql:execute-multi:invoke]", {
          traceId,
          elapsed: elapsed(),
          executionSchema,
          optionKeys: Object.keys(executionOptions),
          clientSession: Boolean(clientSessionId),
        });
        executionPromise = api.executeMulti(tab.connectionId, tab.database, sqlToExecute, executionSchema, executionId, executionOptions);
      }
      const results = annotateQueryResultSources(markQueryResultsRowsRaw(await withFrontendQueryTimeout(executionPromise, frontendTimeoutSecs, t("editor.queryTimeoutError", { seconds: frontendTimeoutSecs }))), queryBaseSql, sourceLabelDatabase, effectiveDbType);
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
        syncDisplayedResultRun(current, queryBaseSql);
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
      // Sync connection state if the error indicates a lost connection
      useConnectionStore().recordConnectionLostError(tab.connectionId, e);
      // Handle manual transaction auto-rollback (e.g. deadlock detected by server,
      // statement error inside a manual transaction, or idle timeout).
      if (tab.autoCommit === false) {
        const errMsg: string = e?.message ?? String(e);
        if (/rolled.?back/i.test(errMsg) || errMsg.includes("已自动回滚")) {
          tab.txnSessionId = undefined;
          tab.txnAutoRolledBack = true;
        }
      }
      const current = tabs.value.find((t) => t.id === id);
      if (current?.executionId === executionId) {
        current.result = toErrorResult(e);
        current.results = undefined;
        current.activeResultIndex = undefined;
        current.queryAnalysis = undefined;
        current.querySourceColumns = undefined;
        current.queryEditabilityReason = undefined;
        current.mongoEditTarget = undefined;
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
        syncDisplayedResultRun(current, queryBaseSql);
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
    const clientSessionId = tabClientSessionId(tab, "explain");
    try {
      const result = await api.executeQuery(tab.connectionId, tab.database, built.sql, tab.schema, executionId, {
        clientSessionId,
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
      void closeClientSessionId(tab.connectionId, tab.database, clientSessionId, { tabId: tab.id });
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
      const canceled = await withCancelQueryTimeout(api.cancelQuery(executionId));
      if (canceled) {
        clearAcknowledgedCancelIfStillRunning(id, executionId);
      }
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
      // Sync connection state if the error indicates a lost connection
      if (tab) useConnectionStore().recordConnectionLostError(tab.connectionId, e);
      const current = tabs.value.find((t) => t.id === id);
      if (current && current.executionId === executionId) {
        current.isExecuting = false;
        current.isCancelling = false;
        current.executionId = undefined;
        current.queryExecutionStartedAt = undefined;
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
    tab.resultLocalSortOriginalRows = undefined;
    tab.resultSortColumn = undefined;
    tab.resultSortColumnIndex = undefined;
    tab.resultSortDirection = undefined;
    tab.resultSortMode = undefined;
    touchResult(tab);
    tab.queryAnalysis = undefined;
    tab.querySourceColumns = undefined;
    tab.queryEditabilityReason = undefined;
    tab.mongoEditTarget = undefined;
    syncActiveResultRunFromDisplayed(tab);
  }

  function notifyConnectionMayBeLost() {
    const stuck = tabs.value.filter((t) => t.isExecuting);
    if (stuck.length > 0) {
      const connStore = useConnectionStore();
      stuck.forEach((tab) => {
        tab.isExecuting = false;
        tab.isCancelling = false;
        tab.queryExecutionStartedAt = undefined;
        tab.executionId = undefined;
        const error = new Error(t("editor.connectionMayBeLost"));
        tab.result = toErrorResult(error);
        connStore.markConnectionLost(tab.connectionId, error);
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

  function rememberActiveTab(id: string | null) {
    if (!id || !tabs.value.some((tab) => tab.id === id)) return;
    activeTabHistory.value = [...activeTabHistory.value.filter((tabId) => tabId !== id), id];
  }

  function fallbackActiveTabAfterClose(closedId: string, closedIndex: number): string | null {
    const remainingIds = new Set(tabs.value.map((tab) => tab.id));
    // Prefer the most recently focused remaining tab. This preserves the
    // source query tab when a transient table-info/data tab is closed.
    const history = activeTabHistory.value.filter((tabId) => tabId !== closedId && remainingIds.has(tabId));
    activeTabHistory.value = history;
    return [...history].reverse().find((tabId) => remainingIds.has(tabId)) ?? tabs.value[Math.min(closedIndex, tabs.value.length - 1)]?.id ?? null;
  }

  watch(
    activeTabId,
    (id) => {
      rememberActiveTab(id);
      touchResult(tabs.value.find((tab) => tab.id === id));
    },
    { flush: "sync" },
  );

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
    tab.mongoEditTarget = snapshot.mongoEditTarget;
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
    await executeTabSql(tab.id, sql, {
      resultBaseSql: tab.resultBaseSql ?? sql,
      resultSortedSql: tab.resultSortedSql,
      pagination:
        tab.mode === "data"
          ? {
              limit: tab.resultPageLimit ?? tableOpenPageLimit(useSettingsStore().editorSettings.pageSize),
              offset: tab.resultPageOffset ?? 0,
            }
          : undefined,
    });
  }

  async function fetchTabResultForExport(id: string, onProgress?: (info: { rowsExported: number; totalRows: number | null }) => void): Promise<QueryResult | undefined> {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab?.result) return undefined;

    if (tab.mode === "data") {
      const connStore = useConnectionStore();
      await connStore.ensureConnected(tab.connectionId);
      const conn = connStore.getConfig(tab.connectionId);
      const tableMeta = tableMetaForDataTab(tab);
      if (!tableMeta?.tableName) return tab.result;

      // Use the already-computed total row count as a progress estimate so the
      // export dialog shows a moving bar instead of a stuck 0 while paginating.
      const totalRows = typeof tab.resultTotalRowCount === "number" ? tab.resultTotalRowCount : null;
      const pageLimit = TABLE_DATA_EXPORT_PAGE_SIZE;
      const effectiveDbType = effectiveDatabaseTypeForConnection(conn);
      const primaryKeys = tab.tableMeta ? tab.tableMeta.primaryKeys : tableMeta.primaryKeys;
      const sortOrder = tab.resultSortColumn && tab.resultSortDirection ? `${quoteTableIdentifier(effectiveDbType, tab.resultSortColumn)} ${tab.resultSortDirection.toUpperCase()}` : undefined;
      const orderBy = tab.orderByInput?.trim() || sortOrder;
      const queryTimeoutSecs = queryTimeoutSecsForConnection(conn);
      const rows: QueryResult["rows"] = [];
      let columns: string[] = [];
      let executionTimeMs = 0;
      let offset = 0;
      const clientSessionId = tabClientSessionId(tab, "export");
      const exportExecutionId = uuid();

      try {
        while (true) {
          const sql = await api.buildTableSelectSql({
            databaseType: effectiveDbType,
            schema: tableMeta.schema,
            tableName: tableMeta.tableName,
            tableType: tableMeta.tableType,
            columns: tableMeta.columns.map((column) => column.name),
            primaryKeys,
            whereInput: tab.whereInput,
            orderBy,
            limit: pageLimit,
            offset,
          });
          const results = await api.executeMulti(tab.connectionId, tab.database, sql, undefined, exportExecutionId, {
            maxRows: pageLimit,
            fetchSize: pageLimit,
            clientSessionId,
            timeoutSecs: queryTimeoutSecs,
          });
          const result = results[0];
          if (!result) break;
          if (columns.length === 0) columns = result.columns;
          rows.push(...result.rows);
          executionTimeMs += result.execution_time_ms ?? 0;
          onProgress?.({ rowsExported: rows.length, totalRows });
          if (result.rows.length < pageLimit) break;
          offset += result.rows.length;
        }
      } finally {
        void closeClientSessionId(tab.connectionId, tab.database, clientSessionId, { tabId: tab.id });
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
    const useAgentCursor = usesAgentCursorForQuery(conn?.db_type);
    const queryBaseSql = tab.resultBaseSql ?? sql;
    const exportSettings = useSettingsStore().editorSettings;
    const exportRowLimit = exportSettings.exportRowLimitEnabled ? exportSettings.exportRowLimit : Number.POSITIVE_INFINITY;
    const agentExportMaxRows = exportSettings.exportRowLimitEnabled ? exportSettings.exportRowLimit : 2_147_483_647;
    // Use the already-computed total row count as a progress estimate so the
    // export dialog shows a moving bar instead of a stuck 0 while paginating.
    const totalRows = typeof tab.resultTotalRowCount === "number" ? Math.min(tab.resultTotalRowCount, exportRowLimit) : null;
    const pageLimit = Math.max(tab.resultPageLimit ?? 0, TABLE_DATA_EXPORT_PAGE_SIZE);
    const rows: QueryResult["rows"] = [];
    let columns: string[] = [];
    let executionTimeMs = 0;
    let offset = 0;
    let sessionId: string | undefined;
    const clientSessionId = tabClientSessionId(tab, "export");
    const exportExecutionId = uuid();

    try {
      while (rows.length < exportRowLimit) {
        const remaining = exportRowLimit - rows.length;
        const effectivePageLimit = Math.min(pageLimit, remaining);
        const plan = await api.prepareQueryPaginationExecutionPlan({
          sql,
          queryBaseSql,
          databaseType: effectiveDbType,
          pagination: { limit: effectivePageLimit, offset, sessionId },
          useAgentCursor,
          firstPageUsesActualSql: true,
        });
        if (typeof plan.pageLimit !== "number" || typeof plan.pageOffset !== "number") return tab.result;
        const executionOptions = plan.useAgentResultSession
          ? {
              maxRows: agentExportMaxRows,
              fetchSize: plan.pageLimit,
              pageSize: plan.pageLimit,
              resultSessionId: sessionId,
              clientSessionId,
              timeoutSecs: queryTimeoutSecs,
            }
          : { maxRows: plan.pageLimit, fetchSize: plan.pageLimit, clientSessionId, timeoutSecs: queryTimeoutSecs };
        const results = await api.executeMulti(tab.connectionId, tab.database, plan.sqlToExecute, tab.schema, exportExecutionId, executionOptions);
        const result = results[0];
        if (!result) break;
        if (columns.length === 0) columns = result.columns;
        rows.push(...result.rows);
        executionTimeMs += result.execution_time_ms ?? 0;
        onProgress?.({ rowsExported: rows.length, totalRows });
        sessionId = result.session_id ?? undefined;
        const shouldFetchNextPage = plan.useAgentResultSession ? result.has_more === true : result.rows.length >= plan.pageLimit;
        if (!shouldFetchNextPage || rows.length >= exportRowLimit) break;
        offset += result.rows.length;
      }
    } finally {
      if (sessionId) void api.closeQuerySession(tab.connectionId, tab.database, sessionId, clientSessionId);
      void closeClientSessionId(tab.connectionId, tab.database, clientSessionId, { tabId: tab.id });
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

  async function buildQueryResultExportRequest(id: string, options: BuildQueryResultExportRequestOptions) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab?.result || tab.mode !== "query") return undefined;

    const sql = tab.resultSortedSql ?? tab.resultBaseSql ?? tab.lastExecutedSql ?? tab.sql;
    if (!sql.trim()) return undefined;

    const connStore = useConnectionStore();
    await connStore.ensureConnected(tab.connectionId);
    const conn = connStore.getConfig(tab.connectionId);
    const settings = useSettingsStore().editorSettings;
    const effectiveDbType = effectiveDatabaseTypeForConnection(conn);
    if (!effectiveDbType) return undefined;
    const useAgentCursor = usesAgentCursorForQuery(conn?.db_type);
    const queryBaseSql = tab.resultBaseSql ?? sql;
    const rowLimit = settings.exportRowLimitEnabled ? settings.exportRowLimit : null;
    const totalRows = typeof tab.resultTotalRowCount === "number" ? (rowLimit === null ? tab.resultTotalRowCount : Math.min(tab.resultTotalRowCount, rowLimit)) : null;
    const clientSessionId = tabClientSessionId(tab, "export");

    return {
      exportId: options.exportId,
      connectionId: tab.connectionId,
      database: tab.database,
      schema: tab.schema,
      sql,
      queryBaseSql,
      databaseType: effectiveDbType,
      useAgentCursor,
      filePath: options.filePath,
      format: options.format,
      pageSize: settings.exportBatchSize,
      rowLimit,
      totalRows,
      timeoutSecs: queryTimeoutSecsForConnection(conn),
      keysetOptimizationEnabled: settings.queryExportKeysetOptimizationEnabled,
      clientSessionId,
      executionId: uuid(),
    };
  }

  return {
    tabs,
    activeTabId,
    isOpenTabsLoaded,
    initOpenTabs,
    showCloseConfirm,
    pendingCloseTabId,
    closeConfirmContext,
    closeConfirmDirtyTabIds,
    hasDirtyTabs,
    isConfirmingAppClose,
    createTab,
    closeTab,
    forceClosePendingTab,
    forceCloseAllPendingTabs,
    cancelClosePendingTab,
    flushPendingPersist,
    saveAndClosePendingTab,
    suspendCloseConfirm,
    resumeCloseConfirm,
    completePendingCloseAfterSaveAll,
    isTabDirty,
    markTabClean,
    discardTabChanges,
    requestAppCloseConfirmation,
    closeOtherTabs,
    closeOtherRegularTabs,
    closeRegularTabs,
    closeOtherFixedTabs,
    closeFixedTabs,
    closeAllTabs,
    duplicateTab,
    closeConnectionTabs,
    closeDatabaseTabs,
    closeDroppedTableObjectTabs,
    releaseConnectionTabs,
    releaseDatabaseTabs,
    isDatabaseOpen,
    rollbackConnectionTransactions,
    rollbackDatabaseTransactions,
    updateSql,
    updateEditorViewport,
    updateEditorSelection,
    setAutoCommit,
    commitTransaction,
    rollbackTransaction,
    renameTab,
    openObjectBrowser,
    openMongoGridFs,
    openMongoBucket,
    openUserAdmin,
    openDamengJobAdmin,
    openMqAdmin,
    openNacosAdmin,
    openTableStructure,
    linkSavedSql,
    linkExternalSqlPath,
    openSavedSql,
    hydrateSavedSqlTabs,
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
    toggleResultAutoSave,
    setActiveResultRun,
    removeResultRun,
    setActiveResultIndex,
    executeCurrentTab,
    executeCurrentSql,
    executeTabSql,
    sortTabResultLocally,
    explainTabSql,
    cancelTabExecution,
    cancelTabExplain,
    reloadEvictedTab,
    exportResultArchive,
    importResultArchive,
    fetchTabResultForExport,
    buildQueryResultExportRequest,
    notifyConnectionMayBeLost,
  };
});
