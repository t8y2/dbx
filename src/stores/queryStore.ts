import { defineStore } from "pinia";
import { ref } from "vue";
import type { QueryTab } from "@/types/database";
import { orderPinnedFirst } from "@/lib/pinnedItems";
import { canCancelQueryExecution } from "@/lib/queryExecutionState";
import { closeAllTabsState, closeOtherTabsState } from "@/lib/tabCloseActions";
import * as api from "@/lib/tauri";

export const useQueryStore = defineStore("query", () => {
  const tabs = ref<QueryTab[]>([]);
  const activeTabId = ref<string | null>(null);
  const MAX_CACHED_RESULTS = 10;

  function findTabByTitle(connectionId: string, database: string, title: string) {
    return tabs.value.find((t) => t.connectionId === connectionId && t.database === database && t.title === title);
  }

  function createTab(connectionId: string, database: string, title?: string, mode: "data" | "query" | "redis" | "mongo" = "query") {
    if (title) {
      const existing = findTabByTitle(connectionId, database, title);
      if (existing) {
        activeTabId.value = existing.id;
        return existing.id;
      }
    }

    const id = crypto.randomUUID();
    const tab: QueryTab = {
      id,
      title: title || `Query ${tabs.value.length + 1}`,
      connectionId,
      database,
      sql: "",
      isExecuting: false,
      isCancelling: false,
      mode,
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function closeTab(id: string) {
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx < 0) return;
    if (tabs.value[idx].isExecuting) void cancelTabExecution(id);
    tabs.value.splice(idx, 1);
    if (activeTabId.value === id) {
      activeTabId.value = tabs.value[Math.min(idx, tabs.value.length - 1)]?.id ?? null;
    }
  }

  function closeOtherTabs(id: string) {
    tabs.value
      .filter((tab) => tab.id !== id && tab.isExecuting)
      .forEach((tab) => void cancelTabExecution(tab.id));
    const next = closeOtherTabsState(tabs.value, activeTabId.value, id);
    tabs.value = next.tabs;
    activeTabId.value = next.activeTabId;
  }

  function closeAllTabs() {
    tabs.value
      .filter((tab) => tab.isExecuting)
      .forEach((tab) => void cancelTabExecution(tab.id));
    const next = closeAllTabsState(tabs.value, activeTabId.value);
    tabs.value = next.tabs;
    activeTabId.value = next.activeTabId;
  }

  function updateSql(id: string, sql: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (tab) tab.sql = sql;
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
    tab.result = undefined;
    tab.lastExecutedSql = undefined;
    tab.tableMeta = undefined;
  }

  function updateConnection(id: string, connectionId: string, database = "") {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || tab.connectionId === connectionId) return;
    tab.connectionId = connectionId;
    tab.database = database;
    tab.result = undefined;
    tab.lastExecutedSql = undefined;
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
    await executeTabSql(activeTabId.value, sql);
  }

  async function executeTabSql(id: string, sql: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || !sql.trim()) return;

    const executionId = crypto.randomUUID();
    tab.isExecuting = true;
    tab.isCancelling = false;
    tab.executionId = executionId;
    tab.lastExecutedSql = sql;
    try {
      tab.result = await api.executeQuery(tab.connectionId, tab.database, sql, executionId);
    } catch (e: any) {
      const current = tabs.value.find((t) => t.id === id);
      if (current?.executionId === executionId) {
        current.result = toErrorResult(e);
      }
    } finally {
      const current = tabs.value.find((t) => t.id === id);
      if (current?.executionId === executionId) {
        current.isExecuting = false;
        current.isCancelling = false;
        current.executionId = undefined;
      }
    }
    trimResultCache();
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

  function trimResultCache() {
    const inactive = tabs.value.filter((t) => t.id !== activeTabId.value && t.result);
    if (inactive.length > MAX_CACHED_RESULTS) {
      const toEvict = inactive.slice(0, inactive.length - MAX_CACHED_RESULTS);
      toEvict.forEach((t) => { t.result = undefined; });
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
    togglePinnedTab,
    updateDatabase,
    updateConnection,
    setTableMeta,
    setExecuting,
    setErrorResult,
    executeCurrentTab,
    executeCurrentSql,
    executeTabSql,
    cancelTabExecution,
  };
});
