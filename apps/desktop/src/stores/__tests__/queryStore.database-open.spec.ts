import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_TAB_STORAGE_KEY, OPEN_TABS_STORAGE_KEY } from "@/lib/app/openTabsPersistence";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
  return data;
}

describe("queryStore database open state", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("tracks whether a connection database has open tabs", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const tabId = store.createTab("pg-1", "app", "query_1");

    expect(store.isDatabaseOpen("pg-1", "app")).toBe(true);
    expect(store.isDatabaseOpen("pg-1", "analytics")).toBe(false);
    expect(store.isDatabaseOpen("pg-2", "app")).toBe(false);

    store.updateDatabase(tabId, "analytics");

    expect(store.isDatabaseOpen("pg-1", "app")).toBe(false);
    expect(store.isDatabaseOpen("pg-1", "analytics")).toBe(true);

    store.closeTab(tabId);

    expect(store.isDatabaseOpen("pg-1", "analytics")).toBe(false);
  });

  it("keeps object browser viewport per tab and clears it on schema change", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const tabId = store.openObjectBrowser("pg-1", "app", "public");
    store.updateObjectBrowserViewport(tabId, { scrollTop: 340, viewMode: "list" });

    const tab = store.tabs.find((item) => item.id === tabId);
    expect(tab?.objectBrowser?.viewport).toEqual({ scrollTop: 340, viewMode: "list" });

    store.updateSchema(tabId, "archive");

    expect(tab?.objectBrowser?.schema).toBe("archive");
    expect(tab?.objectBrowser?.viewport).toBeUndefined();
  });

  it("keeps external catalog object browsers isolated", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const icebergTabId = store.openObjectBrowser("doris-1", "default", undefined, "iceberg_catalog");
    const hiveTabId = store.openObjectBrowser("doris-1", "default", undefined, "hive_catalog");

    expect(hiveTabId).not.toBe(icebergTabId);
    expect(store.tabs.find((tab) => tab.id === icebergTabId)?.objectBrowser?.catalog).toBe("iceberg_catalog");
    expect(store.tabs.find((tab) => tab.id === hiveTabId)?.objectBrowser?.catalog).toBe("hive_catalog");
    expect(store.openObjectBrowser("doris-1", "default", undefined, "iceberg_catalog")).toBe(icebergTabId);
  });

  it("closes data and structure tabs for a dropped table object", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const queryId = store.createTab("pg-1", "app", "Query", "query", "public");
    const dataId = store.createTab("pg-1", "app", "users", "data", "public");
    store.setTableMeta(dataId, {
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      columns: [],
      primaryKeys: [],
    });
    const otherSchemaDataId = store.createTab("pg-1", "app", "users", "data", "archive");
    store.setTableMeta(otherSchemaDataId, {
      schema: "archive",
      tableName: "users",
      tableType: "TABLE",
      columns: [],
      primaryKeys: [],
    });
    const otherConnectionDataId = store.createTab("pg-2", "app", "users", "data", "public");
    store.setTableMeta(otherConnectionDataId, {
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      columns: [],
      primaryKeys: [],
    });
    const structureId = store.openTableStructure("pg-1", "app", "public", "users");

    store.activeTabId = dataId;
    store.closeDroppedTableObjectTabs({
      connectionId: "pg-1",
      database: "app",
      schema: "public",
      name: "users",
      objectType: "TABLE",
    });

    expect(store.tabs.some((tab) => tab.id === dataId)).toBe(false);
    expect(store.tabs.some((tab) => tab.id === structureId)).toBe(false);
    expect(store.tabs.some((tab) => tab.id === otherSchemaDataId)).toBe(true);
    expect(store.tabs.some((tab) => tab.id === otherConnectionDataId)).toBe(true);
    expect(store.tabs.some((tab) => tab.id === queryId)).toBe(true);
    expect(store.activeTabId).not.toBe(dataId);
  });

  it("closes data tabs but keeps structure tabs for dropped views", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const dataId = store.createTab("pg-1", "app", "report_view", "data", "public");
    store.setTableMeta(dataId, {
      schema: "public",
      tableName: "report_view",
      tableType: "VIEW",
      columns: [],
      primaryKeys: [],
    });
    const structureId = store.openTableStructure("pg-1", "app", "public", "report_view");

    store.closeDroppedTableObjectTabs({
      connectionId: "pg-1",
      database: "app",
      schema: "public",
      name: "report_view",
      objectType: "VIEW",
    });

    expect(store.tabs.some((tab) => tab.id === dataId)).toBe(false);
    expect(store.tabs.some((tab) => tab.id === structureId)).toBe(true);
  });

  it("matches dropped table schema candidates", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const dataId = store.createTab("pg-1", "app", "orders", "data", "app");
    store.setTableMeta(dataId, {
      schema: "app",
      tableName: "orders",
      tableType: "TABLE",
      columns: [],
      primaryKeys: [],
    });
    const structureId = store.openTableStructure("pg-1", "app", undefined, "orders");

    store.closeDroppedTableObjectTabs({
      connectionId: "pg-1",
      database: "app",
      schema: "app",
      schemaCandidates: [undefined, "app"],
      name: "orders",
      objectType: "TABLE",
    });

    expect(store.tabs.some((tab) => tab.id === dataId)).toBe(false);
    expect(store.tabs.some((tab) => tab.id === structureId)).toBe(false);
  });

  it("does not restore open tabs when launch restore mode is none", async () => {
    const persistedTabs = JSON.stringify([
      {
        id: "tab-1",
        title: "Query 1",
        connectionId: "pg-1",
        database: "app",
        sql: "select 1",
      },
    ]);

    vi.resetModules();
    vi.unstubAllGlobals();
    const storage = installLocalStorage();
    storage.set("dbx-editor-settings", JSON.stringify({ openTabsRestoreMode: "none" }));
    storage.set("dbx-app-state:open_tabs", JSON.stringify({ tabs: JSON.parse(persistedTabs), activeTabId: "tab-1" }));
    storage.set(OPEN_TABS_STORAGE_KEY, persistedTabs);
    storage.set(ACTIVE_TAB_STORAGE_KEY, "tab-1");
    setActivePinia(createPinia());

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    await useSettingsStore().initEditorSettings();
    const store = useQueryStore();
    await store.initOpenTabs();

    expect(store.tabs).toEqual([]);
    expect(store.activeTabId).toBeNull();
    expect(storage.get(OPEN_TABS_STORAGE_KEY)).toBeUndefined();
    expect(storage.get(ACTIVE_TAB_STORAGE_KEY)).toBeUndefined();
    expect(JSON.parse(storage.get("dbx-app-state:open_tabs") ?? "{}")).toEqual({ tabs: [], activeTabId: null });
  });

  it("restores only pinned tabs when launch restore mode is pinned", async () => {
    const persistedTabs = JSON.stringify([
      {
        id: "tab-1",
        title: "Pinned",
        connectionId: "pg-1",
        database: "app",
        sql: "select 1",
        pinned: true,
      },
      {
        id: "tab-2",
        title: "Regular",
        connectionId: "pg-1",
        database: "app",
        sql: "select 2",
      },
    ]);

    vi.resetModules();
    vi.unstubAllGlobals();
    const storage = installLocalStorage();
    storage.set("dbx-editor-settings", JSON.stringify({ openTabsRestoreMode: "pinned" }));
    storage.set(OPEN_TABS_STORAGE_KEY, persistedTabs);
    storage.set(ACTIVE_TAB_STORAGE_KEY, "tab-2");
    setActivePinia(createPinia());

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    await useSettingsStore().initEditorSettings();
    const store = useQueryStore();
    await store.initOpenTabs();

    expect(store.tabs.map((tab) => tab.id)).toEqual(["tab-1"]);
    expect(store.activeTabId).toBe("tab-1");
  });
});
