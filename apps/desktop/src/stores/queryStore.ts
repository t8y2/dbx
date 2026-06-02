import { defineStore } from "pinia";
import { uuid } from "@/lib/utils";
import { ref, watch, computed } from "vue";
import { useI18n } from "vue-i18n";
import type { DatabaseType, QueryResult, QueryTab } from "@/types/database";
import { orderPinnedFirst } from "@/lib/pinnedItems";
import { canCancelQueryExecution } from "@/lib/queryExecutionState";
import { closeAllTabsState, closeOtherTabsState } from "@/lib/tabCloseActions";
import { buildExplainSql, parseExplainResult } from "@/lib/explainPlan";
import { allEditableColumnsWriteable, allPrimaryKeysPresent, sourceColumnsForResult } from "@/lib/sqlAnalysis";
import { restoreOpenTabsState, serializeOpenTabs } from "@/lib/openTabsPersistence";
import {
  evaluateMongoAggregateSafety,
  mongoCountToQueryResult,
  mongoDocumentsToQueryResult,
  mongoWriteToQueryResult,
  parseMongoAggregateCommand,
  parseMongoCountDocumentsCommand,
  parseMongoFindCommand,
  parseMongoWriteCommand,
  type MongoAggregateSafetyOptions,
} from "@/lib/mongoShellCommand";
import { AGENT_DRIVER_TYPES } from "@/lib/databaseCapabilities";
import { editablePrimaryKeys } from "@/lib/tableEditing";
import { TABLE_DATA_EXPORT_PAGE_SIZE } from "@/lib/tableDataExport";
import { queryTimeoutSecsForConnection } from "@/lib/queryTimeout";
import * as api from "@/lib/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { SavedSqlFile } from "@/types/database";

const STORAGE_KEY = "dbx-open-tabs";
const ACTIVE_TAB_KEY = "dbx-active-tab";

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
    if (tab?.result || tab?.results) tab.resultAccessedAt = accessedAt;
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
  }

  async function evictCachedResult(tab: QueryTab) {
    await closeResultSession(tab);
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

  function findTabByIdentity(
    connectionId: string,
    database: string,
    title: string,
    mode: QueryTab["mode"],
    schema?: string,
  ) {
    return tabs.value.find(
      (tab) =>
        tab.connectionId === connectionId &&
        tab.database === database &&
        tab.title === title &&
        tab.mode === mode &&
        (tab.schema || "") === (schema || ""),
    );
  }

  function createTab(
    connectionId: string,
    database: string,
    title?: string,
    mode: QueryTab["mode"] = "query",
    schema?: string,
  ) {
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
      title: title || `Query ${tabs.value.length + 1}`,
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
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function openObjectBrowser(connectionId: string, database: string, schema?: string) {
    const title = schema ? `${schema} objects` : `${database} objects`;
    const existing = tabs.value.find(
      (tab) =>
        tab.mode === "objects" &&
        tab.connectionId === connectionId &&
        tab.database === database &&
        (tab.objectBrowser?.schema || "") === (schema || ""),
    );
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

  function openTableStructure(connectionId: string, database: string, schema?: string, tableName?: string) {
    const resolvedTableName = tableName || "";
    if (resolvedTableName) {
      const existing = tabs.value.find(
        (tab) =>
          tab.mode === "structure" &&
          tab.connectionId === connectionId &&
          tab.database === database &&
          (tab.structureTableName || "") === resolvedTableName,
      );
      if (existing) {
        activeTabId.value = existing.id;
        return existing.id;
      }
    }

    const title = resolvedTableName
      ? t("structureEditor.editTabTitle", { tableName: resolvedTableName })
      : t("structureEditor.createTitle");
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

  function closeTab(id: string) {
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx < 0) return;
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

  function closeOtherTabs(id: string) {
    tabs.value
      .filter((tab) => tab.id !== id)
      .forEach((tab) => {
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

  function closeTabsWhere(predicate: (tab: QueryTab) => boolean) {
    const closingIds = new Set(tabs.value.filter((tab) => predicate(tab)).map((tab) => tab.id));
    if (closingIds.size === 0) return;

    tabs.value
      .filter((tab) => closingIds.has(tab.id))
      .forEach((tab) => {
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

  function updateSql(id: string, sql: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (tab) {
      tab.sql = sql;
    }
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
    if (!isExecuting) {
      tab.isCancelling = false;
      tab.executionId = undefined;
    }
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
    return {
      columns: ["Error"],
      rows: [[message]],
      affected_rows: 0,
      execution_time_ms: 0,
    };
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
    tab.executionId = undefined;
  }

  async function executeCurrentTab() {
    const tab = tabs.value.find((t) => t.id === activeTabId.value);
    if (!tab || !tab.sql.trim()) return;

    await executeCurrentSql(tab.sql);
  }

  async function executeCurrentSql(sql: string) {
    if (!activeTabId.value) return;
    await executeTabSql(activeTabId.value, sql, { resultBaseSql: sql, resultSortedSql: undefined });
  }

  type QueryMetadataPatch = Pick<
    QueryTab,
    "queryAnalysis" | "querySourceColumns" | "queryEditabilityReason" | "tableMeta"
  >;

  function applyQueryMetadataPatch(tab: QueryTab, patch: QueryMetadataPatch) {
    tab.queryAnalysis = patch.queryAnalysis;
    tab.querySourceColumns = patch.querySourceColumns;
    tab.queryEditabilityReason = patch.queryEditabilityReason;
    tab.tableMeta = patch.tableMeta;
  }

  async function buildQueryMetadataPatch(
    tab: QueryTab,
    sql: string,
    traceId?: string,
    elapsed?: () => string,
  ): Promise<QueryMetadataPatch | undefined> {
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
      if (dbType === "postgres") schema = "public";
      else schema = "";
    }

    try {
      console.info("[DBX][executeTabSql:metadata:get-columns:start]", {
        traceId,
        schema,
        table: analysis.tableName,
        elapsed: elapsed?.(),
      });
      const columns = await api.getColumns(tab.connectionId, tab.database, schema, analysis.tableName);
      console.info("[DBX][executeTabSql:metadata:get-columns:done]", {
        traceId,
        columnCount: columns.length,
        elapsed: elapsed?.(),
      });
      const primaryKeys = editablePrimaryKeys(dbType as DatabaseType, columns);
      const tableMeta = {
        schema: schema || undefined,
        tableName: analysis.tableName,
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

      if (!allPrimaryKeysPresent(primaryKeys, tab.result.columns, analysis)) {
        return {
          queryAnalysis: undefined,
          querySourceColumns: undefined,
          queryEditabilityReason: "primary-key-not-returned",
          tableMeta,
        };
      }

      if (!allEditableColumnsWriteable(analysis, tab.result.columns)) {
        return {
          queryAnalysis: undefined,
          querySourceColumns: undefined,
          queryEditabilityReason: "aliased-columns",
          tableMeta,
        };
      }

      return {
        queryAnalysis: analysis,
        querySourceColumns: sourceColumnsForResult(analysis, tab.result.columns),
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

  function analyzeQueryMetadataInBackground(
    tabId: string,
    sql: string,
    result: QueryResult,
    traceId: string,
    elapsed: () => string,
  ) {
    void (async () => {
      const tab = tabs.value.find((t) => t.id === tabId);
      if (!tab || tab.result !== result) return;
      console.info("[DBX][executeTabSql:metadata:start]", { traceId, elapsed: elapsed() });
      const patch = await buildQueryMetadataPatch(tab, sql, traceId, elapsed);
      const current = tabs.value.find((t) => t.id === tabId);
      if (patch && current?.result === result) {
        applyQueryMetadataPatch(current, patch);
        console.info("[DBX][executeTabSql:metadata:done]", { traceId, elapsed: elapsed() });
      } else {
        console.warn("[DBX][executeTabSql:metadata:stale]", { traceId, elapsed: elapsed() });
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
    tab.executionId = executionId;
    tab.lastExecutedSql = sql;
    tab.resultTotalRowCount = undefined;
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
      const useAgentCursor = !!conn?.db_type && AGENT_DRIVER_TYPES.has(conn.db_type);
      const queryTimeoutSecs = queryTimeoutSecsForConnection(conn);
      const settingsStore = useSettingsStore();
      await previousResultSessionClose;
      if (tab.mode === "query") {
        const pagination = options?.pagination ?? { limit: settingsStore.editorSettings.pageSize, offset: 0 };
        const plan = await api.prepareQueryPaginationExecutionPlan({
          sql,
          queryBaseSql,
          databaseType: conn?.db_type,
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
        const result = await api.mongoFindDocuments(
          tab.connectionId,
          tab.database,
          mongoFind.collection,
          mongoFind.skip,
          mongoFind.limit,
          mongoFind.filter,
          mongoFind.sort,
        );
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
          current.result = mongoDocumentsToQueryResult(result.documents, performance.now() - startedAt, result.total);
          touchResult(current);
          current.queryAnalysis = undefined;
          current.querySourceColumns = undefined;
          current.queryEditabilityReason = undefined;
          current.tableMeta = undefined;
          current.resultBaseSql = options?.resultBaseSql ?? sql;
          current.resultSortedSql = options?.resultSortedSql;
        }
        return;
      }
      const mongoCount = conn?.db_type === "mongodb" ? parseMongoCountDocumentsCommand(sql) : null;
      if (mongoCount) {
        await connStore.ensureConnected(tab.connectionId);
        console.info("[DBX][executeTabSql:mongo-count:start]", { traceId, collection: mongoCount.collection });
        const result = await api.mongoFindDocuments(
          tab.connectionId,
          tab.database,
          mongoCount.collection,
          0,
          1,
          mongoCount.filter,
        );
        console.info("[DBX][executeTabSql:mongo-count:done]", {
          traceId,
          total: result.total,
          elapsed: elapsed(),
        });
        const current = tabs.value.find((t) => t.id === id);
        if (current?.executionId === executionId) {
          current.results = undefined;
          current.activeResultIndex = undefined;
          current.result = mongoCountToQueryResult(result.total, performance.now() - startedAt);
          touchResult(current);
          current.queryAnalysis = undefined;
          current.querySourceColumns = undefined;
          current.queryEditabilityReason = undefined;
          current.tableMeta = undefined;
          current.resultBaseSql = options?.resultBaseSql ?? sql;
          current.resultSortedSql = options?.resultSortedSql;
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
        const result = await api.mongoAggregateDocuments(
          tab.connectionId,
          tab.database,
          mongoAggregate.collection,
          mongoAggregate.pipeline,
          pageLimit,
        );
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
          current.result = mongoDocumentsToQueryResult(result.documents, performance.now() - startedAt, result.total);
          touchResult(current);
          current.queryAnalysis = undefined;
          current.querySourceColumns = undefined;
          current.queryEditabilityReason = undefined;
          current.tableMeta = undefined;
          current.resultBaseSql = options?.resultBaseSql ?? sql;
          current.resultSortedSql = options?.resultSortedSql;
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
          const result = await api.mongoInsertDocuments(
            tab.connectionId,
            tab.database,
            mongoWrite.collection,
            mongoWrite.docsJson,
          );
          affectedRows = result.affected_rows;
        } else if (mongoWrite.kind === "update") {
          const result = await api.mongoUpdateDocuments(
            tab.connectionId,
            tab.database,
            mongoWrite.collection,
            mongoWrite.filter,
            mongoWrite.update,
            mongoWrite.many,
          );
          affectedRows = result.affected_rows;
        } else {
          const result = await api.mongoDeleteDocuments(
            tab.connectionId,
            tab.database,
            mongoWrite.collection,
            mongoWrite.filter,
            mongoWrite.many,
          );
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
          current.result = mongoWriteToQueryResult(affectedRows, performance.now() - startedAt);
          touchResult(current);
          current.queryAnalysis = undefined;
          current.querySourceColumns = undefined;
          current.queryEditabilityReason = undefined;
          current.tableMeta = undefined;
          current.resultBaseSql = options?.resultBaseSql ?? sql;
          current.resultSortedSql = options?.resultSortedSql;
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
      const executionSchema = tab.mode === "data" ? undefined : tab.schema;
      const executionPromise = api.executeMulti(
        tab.connectionId,
        tab.database,
        sqlToExecute,
        executionSchema,
        executionId,
        executionOptions,
      );
      const results =
        queryTimeoutSecs === 0
          ? await executionPromise
          : await Promise.race([
              executionPromise,
              new Promise<never>((_, reject) => {
                const frontendTimeoutSecs = Math.max(queryTimeoutSecs * 2, 60);
                setTimeout(
                  () => reject(new Error(t("editor.queryTimeoutError", { seconds: frontendTimeoutSecs }))),
                  frontendTimeoutSecs * 1000,
                );
              }),
            ]);
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
        touchResult(current);
        console.info("[DBX][executeTabSql:result:assigned]", {
          traceId,
          activeResultIndex: current.activeResultIndex,
          rowCount: current.result?.rows.length ?? 0,
          columnCount: current.result?.columns.length ?? 0,
          backendMs: current.result?.execution_time_ms,
          elapsed: elapsed(),
        });
        if (countSql && current.result?.rows.length) {
          // When the result set is smaller than the page size we already have
          // all rows — compute the total directly instead of running COUNT(*).
          const resultRowCount = current.result.rows.length;
          if (pageLimit !== undefined && resultRowCount < pageLimit) {
            current.resultTotalRowCount = (pageOffset ?? 0) + resultRowCount;
          } else {
            const capturedExecutionId = executionId;
            const capturedTabId = id;
            const capturedCountSql = countSql;
            const capturedConnectionId = tab.connectionId;
            const capturedDatabase = tab.database;
            const capturedSchema = tab.schema;
            api
              .executeQuery(capturedConnectionId, capturedDatabase ?? "", capturedCountSql, capturedSchema)
              .then((countResult) => {
                const tabAfterCount = tabs.value.find((t) => t.id === capturedTabId);
                if (tabAfterCount?.executionId === capturedExecutionId) {
                  const total = Number(countResult.rows?.[0]?.[0] ?? 0);
                  if (total > 0) {
                    tabAfterCount.resultTotalRowCount = total;
                  }
                }
              })
              .catch(() => {
                // COUNT query failed — silently ignore
              });
          }
        }
        if (current.mode === "query" && current.result)
          analyzeQueryMetadataInBackground(id, queryBaseSql, current.result, traceId, elapsed);
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
        touchResult(current);
      }
    } finally {
      const current = tabs.value.find((t) => t.id === id);
      if (current?.executionId === executionId) {
        current.isExecuting = false;
        current.isCancelling = false;
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

  async function explainTabSql(id: string, sql: string, databaseType?: DatabaseType) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return { ok: false as const, reason: "empty" as const };
    const conn = useConnectionStore().getConfig(tab.connectionId);
    const queryTimeoutSecs = queryTimeoutSecsForConnection(conn);

    const built = await buildExplainSql(databaseType, sql);
    if (!built.ok) {
      tab.explainPlan = undefined;
      tab.explainError = built.reason;
      return built;
    }

    const executionId = uuid();
    tab.isExplaining = true;
    tab.explainExecutionId = executionId;
    tab.explainError = undefined;
    tab.explainSql = built.sql;
    tab.lastExplainedSql = sql;
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
        if (current && current.executionId === executionId) current.isCancelling = false;
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
  }

  function notifyConnectionMayBeLost() {
    const stuck = tabs.value.filter((t) => t.isExecuting);
    if (stuck.length > 0) {
      stuck.forEach((tab) => {
        tab.isExecuting = false;
        tab.isCancelling = false;
        tab.executionId = undefined;
        tab.result = toErrorResult(new Error(t("editor.connectionMayBeLost")));
      });
    }
  }

  async function trimResultCache() {
    const inactive = tabs.value
      .filter((t) => t.id !== activeTabId.value && (t.result || t.results))
      .sort((a, b) => (a.resultAccessedAt ?? 0) - (b.resultAccessedAt ?? 0));
    if (inactive.length > MAX_CACHED_RESULTS) {
      const toEvict = inactive.slice(0, inactive.length - MAX_CACHED_RESULTS);
      await Promise.all(toEvict.map((t) => evictCachedResult(t)));
    }
  }

  watch(activeTabId, (id) => {
    touchResult(tabs.value.find((tab) => tab.id === id));
  });

  async function reloadEvictedTab(id: string) {
    const tab = tabs.value.find((t) => t.id === id);
    const shouldReloadMissingDataTab = tab?.mode === "data" && !tab.result && !tab.isExecuting;
    if (!tab || (!tab.resultEvicted && !shouldReloadMissingDataTab)) return;
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
    if (tab.mode !== "query") return tab.result;

    const sql = tab.resultSortedSql ?? tab.resultBaseSql ?? tab.lastExecutedSql ?? tab.sql;
    if (!sql.trim()) return tab.result;

    const connStore = useConnectionStore();
    await connStore.ensureConnected(tab.connectionId);
    const conn = connStore.getConfig(tab.connectionId);
    const queryTimeoutSecs = queryTimeoutSecsForConnection(conn);
    const useAgentCursor = !!conn?.db_type && AGENT_DRIVER_TYPES.has(conn.db_type);
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
          databaseType: conn?.db_type,
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
        const results = await api.executeMulti(
          tab.connectionId,
          tab.database,
          plan.sqlToExecute,
          tab.schema,
          undefined,
          executionOptions,
        );
        const result = results[0];
        if (!result) break;
        if (columns.length === 0) columns = result.columns;
        rows.push(...result.rows);
        executionTimeMs += result.execution_time_ms ?? 0;
        sessionId = result.session_id ?? undefined;
        const shouldFetchNextPage = plan.useAgentResultSession
          ? result.has_more === true
          : result.rows.length >= plan.pageLimit;
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
    createTab,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    closeConnectionTabs,
    closeDatabaseTabs,
    updateSql,
    renameTab,
    openObjectBrowser,
    openTableStructure,
    linkSavedSql,
    openSavedSql,
    togglePinnedTab,
    updateDatabase,
    updateSchema,
    updateConnection,
    setTableMeta,
    setObjectSource,
    setExecuting,
    setErrorResult,
    setActiveResultIndex,
    executeCurrentTab,
    executeCurrentSql,
    executeTabSql,
    explainTabSql,
    cancelTabExecution,
    cancelTabExplain,
    reloadEvictedTab,
    fetchTabResultForExport,
    notifyConnectionMayBeLost,
  };
});
