import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveOpenTabsState: vi.fn(),
  loadOpenTabsState: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  saveOpenTabsState: mocks.saveOpenTabsState,
  loadOpenTabsState: mocks.loadOpenTabsState,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn(() => undefined),
    recordConnectionLostError: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    settingsPageActive: false,
    editorSettings: {
      openTabsRestoreMode: "all",
      confirmUnsavedSqlClose: true,
    },
  }),
}));

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

describe("queryStore split reference pane", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.saveOpenTabsState.mockReset().mockResolvedValue(undefined);
    mocks.loadOpenTabsState.mockReset().mockResolvedValue(null);
  });

  async function createStore() {
    const { useQueryStore } = await import("@/stores/queryStore");
    return useQueryStore();
  }

  it("opens a non-active tab in the split pane without switching tabs", async () => {
    const queryStore = await createStore();
    const firstId = queryStore.createTab("conn-1", "db");
    const secondId = queryStore.createTab("conn-1", "db");
    queryStore.updateSql(secondId, "select 2;");
    expect(queryStore.activeTabId).toBe(secondId);

    queryStore.openTabInSplitPane(firstId);

    expect(queryStore.splitPaneTabId).toBe(firstId);
    expect(queryStore.activeTabId).toBe(secondId);
    expect(queryStore.tabs).toHaveLength(2);
  });

  it("defaults the split direction to side-by-side and switches it on demand", async () => {
    const queryStore = await createStore();
    const firstId = queryStore.createTab("conn-1", "db");
    const secondId = queryStore.createTab("conn-1", "db");

    queryStore.openTabInSplitPane(firstId);
    expect(queryStore.splitPaneDirection).toBe("vertical");

    queryStore.setSplitPaneDirection("horizontal");
    expect(queryStore.splitPaneDirection).toBe("horizontal");

    queryStore.openTabInSplitPane(firstId, "horizontal");
    expect(queryStore.splitPaneDirection).toBe("horizontal");
  });

  it("ignores split pane requests for the active tab", async () => {
    const queryStore = await createStore();
    const tabId = queryStore.createTab("conn-1", "db");

    queryStore.openTabInSplitPane(tabId);

    expect(queryStore.splitPaneTabId).toBeNull();
  });

  it("closes the split pane when its tab is closed", async () => {
    const queryStore = await createStore();
    const firstId = queryStore.createTab("conn-1", "db");
    const secondId = queryStore.createTab("conn-1", "db");
    queryStore.openTabInSplitPane(firstId);
    expect(queryStore.splitPaneTabId).toBe(firstId);

    queryStore.closeTab(firstId);

    expect(queryStore.splitPaneTabId).toBeNull();
  });

  it("closes the split pane when its tab becomes the active tab", async () => {
    const queryStore = await createStore();
    const firstId = queryStore.createTab("conn-1", "db");
    const secondId = queryStore.createTab("conn-1", "db");
    queryStore.openTabInSplitPane(firstId);
    expect(queryStore.splitPaneTabId).toBe(firstId);

    queryStore.switchTab(firstId);

    expect(queryStore.activeTabId).toBe(firstId);
    expect(queryStore.splitPaneTabId).toBeNull();
  });

  it("persists and stops persisting the split pane tab with open tabs", async () => {
    const queryStore = await createStore();
    const firstId = queryStore.createTab("conn-1", "db");
    const secondId = queryStore.createTab("conn-1", "db");
    queryStore.openTabInSplitPane(firstId, "horizontal");

    await queryStore.flushPendingPersist();
    const withSplit = mocks.saveOpenTabsState.mock.calls.at(-1)?.[0];
    expect(withSplit.splitPaneTabId).toBe(firstId);
    expect(withSplit.splitPaneDirection).toBe("horizontal");

    queryStore.closeSplitPane();
    await queryStore.flushPendingPersist();
    const withoutSplit = mocks.saveOpenTabsState.mock.calls.at(-1)?.[0];
    expect(withoutSplit.splitPaneTabId).toBeUndefined();
    expect(withoutSplit.splitPaneDirection).toBeUndefined();
  });

  it("restores the split pane tab from the saved state", async () => {
    mocks.loadOpenTabsState.mockResolvedValue({
      tabs: [
        { id: "tab-a", title: "Query 1", connectionId: "conn-1", database: "db", sql: "select 1;", mode: "query" },
        { id: "tab-b", title: "Query 2", connectionId: "conn-1", database: "db", sql: "select 2;", mode: "query" },
      ],
      activeTabId: "tab-a",
      splitPaneTabId: "tab-b",
      splitPaneDirection: "horizontal",
    });
    const queryStore = await createStore();

    await queryStore.initOpenTabs();

    expect(queryStore.splitPaneTabId).toBe("tab-b");
    expect(queryStore.splitPaneDirection).toBe("horizontal");
    expect(queryStore.activeTabId).toBe("tab-a");
  });

  it("falls back to the side-by-side direction for legacy saved state", async () => {
    mocks.loadOpenTabsState.mockResolvedValue({
      tabs: [
        { id: "tab-a", title: "Query 1", connectionId: "conn-1", database: "db", sql: "select 1;", mode: "query" },
        { id: "tab-b", title: "Query 2", connectionId: "conn-1", database: "db", sql: "select 2;", mode: "query" },
      ],
      activeTabId: "tab-a",
      splitPaneTabId: "tab-b",
      splitPaneDirection: "diagonal",
    });
    const queryStore = await createStore();

    await queryStore.initOpenTabs();

    expect(queryStore.splitPaneTabId).toBe("tab-b");
    expect(queryStore.splitPaneDirection).toBe("vertical");
  });

  it("drops a stale split pane tab id on restore", async () => {
    mocks.loadOpenTabsState.mockResolvedValue({
      tabs: [{ id: "tab-a", title: "Query 1", connectionId: "conn-1", database: "db", sql: "select 1;", mode: "query" }],
      activeTabId: "tab-a",
      splitPaneTabId: "tab-gone",
    });
    const queryStore = await createStore();

    await queryStore.initOpenTabs();

    expect(queryStore.splitPaneTabId).toBeNull();
  });
});
