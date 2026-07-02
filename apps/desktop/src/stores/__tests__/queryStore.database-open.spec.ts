import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_TAB_STORAGE_KEY, OPEN_TABS_STORAGE_KEY } from "@/lib/openTabsPersistence";

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
    storage.set(OPEN_TABS_STORAGE_KEY, persistedTabs);
    storage.set(ACTIVE_TAB_STORAGE_KEY, "tab-1");
    setActivePinia(createPinia());

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    expect(store.tabs).toEqual([]);
    expect(store.activeTabId).toBeNull();
    expect(storage.get(OPEN_TABS_STORAGE_KEY)).toBe(persistedTabs);
    expect(storage.get(ACTIVE_TAB_STORAGE_KEY)).toBe("tab-1");
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

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    expect(store.tabs.map((tab) => tab.id)).toEqual(["tab-1"]);
    expect(store.activeTabId).toBe("tab-1");
  });
});
