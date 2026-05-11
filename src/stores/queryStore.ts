import { defineStore } from "pinia";
import { uuid } from "@/lib/utils";
import { ref, watch, computed } from "vue";
import type { DatabaseType, QueryTab } from "@/types/database";
import { orderPinnedFirst } from "@/lib/pinnedItems";
import { canCancelQueryExecution } from "@/lib/queryExecutionState";
import { closeAllTabsState, closeOtherTabsState } from "@/lib/tabCloseActions";
import { buildExplainSql, parseExplainResult } from "@/lib/explainPlan";
import { analyzeEditableQuery, allPrimaryKeysPresent } from "@/lib/sqlAnalysis";
import { restoreOpenTabsState, serializeOpenTabs } from "@/lib/openTabsPersistence";
import * as api from "@/lib/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { isTauriRuntime } from "@/lib/tauriRuntime";
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
    return restoreOpenTabsState(localStorage.getItem(STORAGE_KEY), localStorage.getItem(ACTIVE_TAB_KEY), {
      queryOnly: isTauriRuntime(),
    });
  } catch {
    return { tabs: [], activeTabId: null };
  }
}

export const useQueryStore = defineStore("query", () => {
  const restored = loadSavedTabs();
  const tabs = ref<QueryTab[]>(restored.tabs);
  const activeTabId = ref<string | null>(restored.activeTabId);
  const MAX_CACHED_RESULTS = 10;

  const _persistSnapshot = computed(() =>
    tabs.value.map((t) => ({
      id: t.id,
      title: t.title,
      connectionId: t.connectionId,
      database: t.database,
      schema: t.schema,
      sql: t.sql,
      savedSqlId: t.savedSqlId,
      pinned: t.pinned,
      mode: t.mode,
      objectBrowser: t.objectBrowser,
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

  function findTabByTitle(connectionId: string, database: string, title: string) {
    return tabs.value.find((t) => t.connectionId === connectionId && t.database === database && t.title === title);
  }

  function createTab(connectionId: string, database: string, title?: string, mode: QueryTab["mode"] = "query") {
    if (title) {
      const existing = findTabByTitle(connectionId, database, title);
      if (existing) {
        activeTabId.value = existing.id;
        return existing.id;
      }
    }

    const id = uuid();
    const tab: QueryTab = {
      id,
      title: title || `Query ${tabs.value.length + 1}`,
      connectionId,
      database,
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

  function closeTab(id: string) {
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx < 0) return;
    if (tabs.value[idx].isExecuting) void cancelTabExecution(id);
    if (tabs.value[idx].isExplaining) void cancelTabExplain(id);
    tabs.value[idx].result = undefined;
    tabs.value[idx].results = undefined;
    tabs.value.splice(idx, 1);
    if (activeTabId.value === id) {
      activeTabId.value = tabs.value[Math.min(idx, tabs.value.length - 1)]?.id ?? null;
    }
  }

  function closeOtherTabs(id: string) {
    tabs.value.filter((tab) => tab.id !== id && tab.isExecuting).forEach((tab) => void cancelTabExecution(tab.id));
    tabs.value.filter((tab) => tab.id !== id && tab.isExplaining).forEach((tab) => void cancelTabExplain(tab.id));
    const next = closeOtherTabsState(tabs.value, activeTabId.value, id);
    tabs.value = next.tabs;
    activeTabId.value = next.activeTabId;
  }

  function closeAllTabs() {
    tabs.value.filter((tab) => tab.isExecuting).forEach((tab) => void cancelTabExecution(tab.id));
    tabs.value.filter((tab) => tab.isExplaining).forEach((tab) => void cancelTabExplain(tab.id));
    const next = closeAllTabsState(tabs.value, activeTabId.value);
    tabs.value = next.tabs;
    activeTabId.value = next.activeTabId;
  }

  function updateSql(id: string, sql: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (tab) {
      tab.sql = sql;
      tab.resultSortedSql = undefined;
      tab.resultBaseSql = undefined;
    }
  }

  function linkSavedSql(id: string, savedSqlId: string, title?: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    tab.savedSqlId = savedSqlId;
    if (title) tab.title = title;
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
    tab.database = database;
    tab.schema = undefined;
    tab.objectBrowser = undefined;
    tab.result = undefined;
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
    tab.connectionId = connectionId;
    tab.database = database;
    tab.schema = undefined;
    tab.result = undefined;
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
    return {
      columns: ["Error"],
      rows: [[String(e)]],
      affected_rows: 0,
      execution_time_ms: 0,
    };
  }

  function setErrorResult(id: string, e: any) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    tab.result = toErrorResult(e);
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

  /**
   * Analyze query metadata for result tooltips and editability.
   */
  async function analyzeQueryMetadata(tab: QueryTab, sql: string) {
    if (tab.mode !== "query") return;
    if (!tab.result || !tab.result.columns.length) {
      tab.queryAnalysis = undefined;
      tab.tableMeta = undefined;
      return;
    }

    const analysis = analyzeEditableQuery(sql);
    if (!analysis) {
      tab.queryAnalysis = undefined;
      tab.tableMeta = undefined;
      return;
    }

    if (!tab.connectionId || !tab.database) {
      tab.queryAnalysis = undefined;
      tab.tableMeta = undefined;
      return;
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
      const columns = await api.getColumns(tab.connectionId, tab.database, schema, analysis.tableName);
      const primaryKeys = columns.filter((c) => c.is_primary_key).map((c) => c.name);

      tab.tableMeta = {
        schema: schema || undefined,
        tableName: analysis.tableName,
        columns,
        primaryKeys,
      };

      if (primaryKeys.length === 0 || !allPrimaryKeysPresent(primaryKeys, tab.result.columns)) {
        tab.queryAnalysis = undefined;
        return;
      }

      tab.queryAnalysis = analysis;
    } catch (err) {
      console.error("[DBX] ERROR fetching columns for query metadata:", err);
      tab.queryAnalysis = undefined;
      tab.tableMeta = undefined;
    }
  }

  async function executeTabSql(
    id: string,
    sql: string,
    options?: { resultBaseSql?: string; resultSortedSql?: string | undefined },
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
    console.info("[DBX][executeTabSql:start]", {
      traceId,
      tabId: id,
      mode: tab.mode,
      connectionId: tab.connectionId,
      database: tab.database,
      schema: tab.schema,
      sql,
    });
    try {
      console.info("[DBX][executeTabSql:execute-multi:start]", { traceId, elapsed: elapsed() });
      const results = await api.executeMulti(tab.connectionId, tab.database, sql, tab.schema, executionId);
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
          current.results = results;
          current.activeResultIndex = 0;
          current.result = results[0];
        } else {
          current.results = undefined;
          current.activeResultIndex = undefined;
          current.result = results[0];
        }
        current.resultBaseSql = options?.resultBaseSql ?? sql;
        current.resultSortedSql = options?.resultSortedSql;
        console.info("[DBX][executeTabSql:metadata:start]", { traceId, elapsed: elapsed() });
        await analyzeQueryMetadata(current, current.resultBaseSql);
        console.info("[DBX][executeTabSql:metadata:done]", { traceId, elapsed: elapsed() });
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
        if (current.mode !== "data") current.tableMeta = undefined;
        current.resultBaseSql = options?.resultBaseSql ?? sql;
        current.resultSortedSql = options?.resultSortedSql;
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
    trimResultCache();
  }

  async function explainTabSql(id: string, sql: string, databaseType?: DatabaseType) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return { ok: false as const, reason: "empty" as const };

    const built = buildExplainSql(databaseType, sql);
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
      const result = await api.executeQuery(tab.connectionId, tab.database, built.sql, tab.schema, executionId);
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
  }

  function trimResultCache() {
    const inactive = tabs.value.filter((t) => t.id !== activeTabId.value && t.result);
    if (inactive.length > MAX_CACHED_RESULTS) {
      const toEvict = inactive.slice(0, inactive.length - MAX_CACHED_RESULTS);
      toEvict.forEach((t) => {
        t.result = undefined;
      });
    }
  }

  return {
    tabs,
    activeTabId,
    createTab,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    updateSql,
    openObjectBrowser,
    linkSavedSql,
    openSavedSql,
    togglePinnedTab,
    updateDatabase,
    updateSchema,
    updateConnection,
    setTableMeta,
    setExecuting,
    setErrorResult,
    setActiveResultIndex,
    executeCurrentTab,
    executeCurrentSql,
    executeTabSql,
    explainTabSql,
    cancelTabExecution,
    cancelTabExplain,
  };
});
