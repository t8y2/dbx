import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 10_000 });

// Mock the persistence transport for the whole file: real timers scheduled by
// one test's debounced persist must not leak a previous store's tabs into a
// later test's localStorage-backed restore payload.
const restoreWorkspacePayload = vi.hoisted(() => ({
  tabs: Array.from({ length: 5 }, (_, index) => ({ id: `tab-${index}`, title: `Query ${index + 1}`, connectionId: "pg-1", database: "app", sql: "select 1" })),
  activeTabId: "tab-0",
  groups: Array.from({ length: 5 }, (_, index) => ({ id: `g${index}`, tabIds: [`tab-${index}`], activeTabId: `tab-${index}` })),
  focusedGroupId: "g0",
  orientation: "vertical",
  sizes: [20, 20, 20, 20, 20],
}));

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    loadOpenTabsState: vi.fn(() => Promise.resolve(restoreWorkspacePayload)),
    saveOpenTabsState: vi.fn(() => Promise.resolve()),
  };
});

describe("queryStore editor groups", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.stubGlobal("window", {
      dispatchEvent: vi.fn(),
      setTimeout: vi.fn((_fn: () => void) => 0),
      clearTimeout: vi.fn(),
    });
    setActivePinia(createPinia());
  });

  it("splits down and toggles orientation", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const firstId = store.createTab("pg-1", "app", "Query 1", "query");
    store.createTab("pg-1", "app", "Query 2", "query");

    expect(store.splitTabDown(firstId)).toBe(true);
    expect(store.groups).toHaveLength(2);

    store.setOrientation("horizontal");
    expect(store.orientation).toBe("horizontal");
    store.setOrientation("vertical");
    expect(store.orientation).toBe("vertical");
  });

  it("moves a tab across groups and removes the empty source group", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const firstId = store.createTab("pg-1", "app", "Query 1", "query");
    const secondId = store.createTab("pg-1", "app", "Query 2", "query");
    const thirdId = store.createTab("pg-1", "app", "Query 3", "query");

    store.splitTabRight(firstId);
    const rightGroup = store.groups[1];

    expect(store.moveTabToGroup(secondId, rightGroup.id)).toBe(true);
    expect(rightGroup.tabIds).toContain(secondId);
    expect(store.groups[0].tabIds).toEqual([thirdId]);
    expect(store.groups).toHaveLength(2);
  });

  it("registers an incoming window tab in the focused split group", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const firstId = store.createTab("pg-1", "app", "Query 1", "query");
    store.createTab("pg-1", "app", "Query 2", "query");
    store.splitTabRight(firstId);
    const targetGroupId = store.focusedGroupId;
    const saved = { id: "incoming-tab", title: "Incoming", connectionId: "pg-1", database: "app", sql: "SELECT 42;" };

    expect(store.importTransferredTab(saved)).toBe(saved.id);
    expect(store.groups.find((group) => group.id === targetGroupId)?.tabIds).toContain(saved.id);
    expect(store.groups.find((group) => group.id === targetGroupId)?.activeTabId).toBe(saved.id);
    expect(store.activeTabId).toBe(saved.id);
    expect(store.importTransferredTab(saved)).toBeNull();
    expect(store.groups.flatMap((group) => group.tabIds).filter((id) => id === saved.id)).toHaveLength(1);
  });

  it("prunes the source split and selects a live tab after moving its last tab to another window", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const firstId = store.createTab("pg-1", "app", "Query 1", "query");
    const secondId = store.createTab("pg-1", "app", "Query 2", "query");
    store.splitTabRight(firstId);

    expect(store.detachTabForTransfer(firstId)?.id).toBe(firstId);
    expect(store.groups).toHaveLength(1);
    expect(store.groups[0].tabIds).toEqual([secondId]);
    expect(store.groups[0].activeTabId).toBe(secondId);
    expect(store.activeTabId).toBe(secondId);
    expect(store.tabs.some((tab) => tab.id === firstId)).toBe(false);
  });

  it("imports a whole window group in order, preserves selection, and accepts retries", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const firstId = store.createTab("pg-1", "app", "Existing 1");
    store.createTab("pg-1", "app", "Existing 2");
    store.splitTabRight(firstId);
    const targetGroupId = store.focusedGroupId;
    const entries = ["incoming-1", "incoming-2", "incoming-3"].map((id) => ({
      tab: { id, title: id, connectionId: "pg-1", database: "app", sql: "SELECT 42;" },
    }));

    expect(store.importTransferredTabs(entries, "incoming-2")).toBe(true);
    expect(store.groups.find((group) => group.id === targetGroupId)?.tabIds).toEqual([firstId, ...entries.map((entry) => entry.tab.id)]);
    expect(store.activeTabId).toBe("incoming-2");
    expect(store.importTransferredTabs(entries, "incoming-2")).toBe(true);
    expect(store.tabs.filter((tab) => tab.id.startsWith("incoming"))).toHaveLength(3);
    expect(store.importTransferredTabs([])).toBe(false);
  });

  it("unsplits a secondary group tab back to the main group", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const firstId = store.createTab("pg-1", "app", "Query 1", "query");
    const secondId = store.createTab("pg-1", "app", "Query 2", "query");

    store.splitTabRight(firstId);
    const mainId = store.groups[0].id;

    expect(store.unsplitTab(firstId)).toBe(true);
    expect(store.groups).toHaveLength(1);
    expect(store.groups[0].id).toBe(mainId);
    expect(store.groups[0].tabIds).toEqual([secondId, firstId]);
    expect(store.focusedGroupId).toBe(mainId);
  });

  it("activates a tab atomically across group, focus, and global active tab", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const firstId = store.createTab("pg-1", "app", "Query 1", "query");
    const thirdId = store.createTab("pg-1", "app", "Query 3", "query");

    store.splitTabRight(firstId);
    const leftGroup = store.groups[0];
    const rightGroup = store.groups[1];

    expect(store.activateTab(thirdId)).toBe(true);
    expect(leftGroup.activeTabId).toBe(thirdId);
    expect(store.focusedGroupId).toBe(leftGroup.id);
    expect(store.activeTabId).toBe(thirdId);

    expect(store.activateTab(firstId)).toBe(true);
    expect(rightGroup.activeTabId).toBe(firstId);
    expect(store.focusedGroupId).toBe(rightGroup.id);
    expect(store.activeTabId).toBe(firstId);

    expect(store.activateTab("missing")).toBe(false);
  });

  it("keeps UI state isolated when switching tabs", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const firstId = store.createTab("pg-1", "app", "Query 1", "query");
    const secondId = store.createTab("pg-1", "app", "Query 2", "query");

    store.updateTabUiState(firstId, { activeOutputView: "chart", resultPaneOpen: false });
    store.updateTabUiState(secondId, { activeOutputView: "summary", resultPaneOpen: true });

    store.activateTab(firstId);
    expect(store.tabs.find((tab) => tab.id === firstId)?.uiState).toEqual({ activeOutputView: "chart", resultPaneOpen: false });
    store.activateTab(secondId);
    expect(store.tabs.find((tab) => tab.id === secondId)?.uiState).toEqual({ activeOutputView: "summary", resultPaneOpen: true });
  });

  it("rejects stale or wrong-mode special-page UI updates", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "Keys", "etcd");
    const owner = store.tabs.find((tab) => tab.id === tabId)!;

    store.updateTabPageUiState(tabId, "etcd", { EtcdKeyBrowser: { mode: "search" } }, owner);
    store.updateTabPageUiState(tabId, "query", { QueryEditor: { draft: "stale" } }, owner);
    store.updateTabPageUiState(tabId, "etcd", { EtcdKeyBrowser: { mode: "watch" } }, { ...owner });

    expect(owner.uiState?.page).toEqual({ etcd: { EtcdKeyBrowser: { mode: "search" } } });
  });

  it("persists tab UI state with the open-tabs snapshot", async () => {
    const api = await import("@/lib/backend/api");
    const storeApi = vi.mocked(api.saveOpenTabsState);
    storeApi.mockClear();
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "Query 1", "query");

    store.updateTabUiState(tabId, { activeOutputView: "messages", resultPaneOpen: false });
    store.updateTabPageUiState(tabId, "query", { QueryEditor: { inspectorOpen: true } });
    await store.flushPendingPersist();

    expect(storeApi).toHaveBeenCalledWith(
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            uiState: {
              activeOutputView: "messages",
              resultPaneOpen: false,
              page: { query: { QueryEditor: { inspectorOpen: true } } },
            },
          }),
        ],
      }),
    );
  });

  it("close all in group only closes the same pinned partition as the trigger tab", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const firstId = store.createTab("pg-1", "app", "Query 1", "query");
    const secondId = store.createTab("pg-1", "app", "Query 2", "query");
    const thirdId = store.createTab("pg-1", "app", "Query 3", "query");

    store.togglePinnedTab(secondId);
    const mainId = store.groups[0].id;

    store.closeAllTabsInGroup(mainId, firstId);

    expect(store.tabs.some((tab) => tab.id === firstId)).toBe(false);
    expect(store.tabs.some((tab) => tab.id === thirdId)).toBe(false);
    expect(store.tabs.some((tab) => tab.id === secondId)).toBe(true);

    store.closeAllTabsInGroup(mainId, secondId);
    expect(store.tabs.some((tab) => tab.id === secondId)).toBe(false);
  });

  it("normalizes more than four groups at the restore boundary without orphaning tabs", async () => {
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    await useSettingsStore().initEditorSettings();
    const store = useQueryStore();
    await store.initOpenTabs();

    expect(store.groups.length).toBeLessThanOrEqual(4);
    const assigned = store.groups.flatMap((group) => group.tabIds);
    for (let index = 0; index < 5; index += 1) {
      expect(assigned.filter((candidate) => candidate === `tab-${index}`)).toHaveLength(1);
    }
    expect(store.activeTabId).toBe(store.groups[0].activeTabId);
  });

  it("derives the restored global active tab from the focused group, not the stale payload value", async () => {
    // The payload is internally inconsistent: activeTabId points into g2 while
    // focusedGroupId is g1. Restore must trust the focused group.
    restoreWorkspacePayload.activeTabId = "tab-1";
    restoreWorkspacePayload.groups = [
      { id: "g1", tabIds: ["tab-0"], activeTabId: "tab-0" },
      { id: "g2", tabIds: ["tab-1"], activeTabId: "tab-1" },
    ];
    restoreWorkspacePayload.focusedGroupId = "g1";
    restoreWorkspacePayload.sizes = [50, 50];

    const { useSettingsStore } = await import("@/stores/settingsStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    await useSettingsStore().initEditorSettings();
    const store = useQueryStore();
    await store.initOpenTabs();

    expect(store.focusedGroupId).toBe("g1");
    expect(store.activeTabId).toBe("tab-0");
    expect(store.groups[1].activeTabId).toBe("tab-1");

    restoreWorkspacePayload.activeTabId = "tab-0";
    restoreWorkspacePayload.groups = Array.from({ length: 5 }, (_, index) => ({ id: `g${index}`, tabIds: [`tab-${index}`], activeTabId: `tab-${index}` }));
    restoreWorkspacePayload.focusedGroupId = "g0";
    restoreWorkspacePayload.sizes = [20, 20, 20, 20, 20];
  });
});
