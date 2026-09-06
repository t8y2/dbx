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
