import { defineStore } from "pinia";
import { ref } from "vue";
import type { QueryTab } from "@/types/database";
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
      mode,
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function closeTab(id: string) {
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx < 0) return;
    tabs.value.splice(idx, 1);
    if (activeTabId.value === id) {
      activeTabId.value = tabs.value[Math.min(idx, tabs.value.length - 1)]?.id ?? null;
    }
  }

  function updateSql(id: string, sql: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (tab) tab.sql = sql;
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

  async function executeCurrentTab() {
    const tab = tabs.value.find((t) => t.id === activeTabId.value);
    if (!tab || !tab.sql.trim()) return;

    await executeCurrentSql(tab.sql);
  }

  async function executeCurrentSql(sql: string) {
    const tab = tabs.value.find((t) => t.id === activeTabId.value);
    if (!tab || !sql.trim()) return;

    tab.isExecuting = true;
    tab.lastExecutedSql = sql;
    try {
      tab.result = await api.executeQuery(tab.connectionId, tab.database, sql);
    } catch (e: any) {
      tab.result = {
        columns: ["Error"],
        rows: [[String(e)]],
        affected_rows: 0,
        execution_time_ms: 0,
      };
    } finally {
      tab.isExecuting = false;
    }
    trimResultCache();
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
    updateSql,
    updateDatabase,
    updateConnection,
    setTableMeta,
    executeCurrentTab,
    executeCurrentSql,
  };
});
