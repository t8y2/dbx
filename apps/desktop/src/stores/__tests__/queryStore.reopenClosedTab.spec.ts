import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("queryStore reopenClosedTab", () => {
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

  it("reopens a recently closed query tab with its SQL, database, and position preserved", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "Query 1", "query");
    const tab = store.tabs.find((t) => t.id === tabId)!;
    tab.sql = "SELECT * FROM users WHERE active = true";

    expect(store.canReopenClosedTab).toBe(false);

    store.closeTab(tabId, { force: true });
    expect(store.tabs.find((t) => t.id === tabId)).toBeUndefined();
    expect(store.canReopenClosedTab).toBe(true);

    const reopenedId = store.reopenClosedTab();
    expect(reopenedId).toBeTruthy();
    expect(store.canReopenClosedTab).toBe(false);

    const reopenedTab = store.tabs.find((t) => t.id === reopenedId);
    expect(reopenedTab).toBeDefined();
    expect(reopenedTab?.title).toBe("Query 1");
    expect(reopenedTab?.connectionId).toBe("pg-1");
    expect(reopenedTab?.database).toBe("app");
    expect(reopenedTab?.sql).toBe("SELECT * FROM users WHERE active = true");
    expect(store.activeTabId).toBe(reopenedId);
  });

  it("reopens multiple closed tabs in LIFO order", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    store.createTab("pg-1", "app", "Query 1", "query");
    const id2 = store.createTab("pg-1", "app", "Query 2", "query");
    const id3 = store.createTab("pg-1", "app", "Query 3", "query");

    store.closeTab(id2);
    store.closeTab(id3);

    expect(store.closedTabsHistory.length).toBe(2);

    // LIFO: most recently closed (id3) is reopened first
    const reopenedIdFirst = store.reopenClosedTab();
    const tabFirst = store.tabs.find((t) => t.id === reopenedIdFirst);
    expect(tabFirst?.title).toBe("Query 3");

    // Next is id2
    const reopenedIdSecond = store.reopenClosedTab();
    const tabSecond = store.tabs.find((t) => t.id === reopenedIdSecond);
    expect(tabSecond?.title).toBe("Query 2");

    expect(store.canReopenClosedTab).toBe(false);
    expect(store.reopenClosedTab()).toBeNull();
  });

  it("returns null when closed tabs history is empty", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    expect(store.canReopenClosedTab).toBe(false);
    expect(store.reopenClosedTab()).toBeNull();
  });

  it("clears closed tabs history on clearClosedTabsHistory", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("pg-1", "app", "Query 1", "query");
    store.closeTab(id);
    expect(store.canReopenClosedTab).toBe(true);

    store.clearClosedTabsHistory();
    expect(store.canReopenClosedTab).toBe(false);
    expect(store.reopenClosedTab()).toBeNull();
  });

  it("reopens tab into focused group if original group was pruned", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    store.createTab("pg-1", "app", "Query 1", "query");
    const id2 = store.createTab("pg-1", "app", "Query 2", "query");

    expect(store.splitTabDown(id2)).toBe(true);
    expect(store.groups.length).toBe(2);

    // Closing id2 leaves the second group empty, so it gets pruned
    store.closeTab(id2);
    expect(store.groups.length).toBe(1);

    // Reopening id2 falls back to the remaining group
    const reopenedId = store.reopenClosedTab();
    expect(reopenedId).toBeTruthy();
    expect(store.groups[0].tabIds).toContain(reopenedId);
    expect(store.activeTabId).toBe(reopenedId);
  });

  it("respects pinned tab boundaries when reopening an unpinned tab", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const pinnedId = store.createTab("pg-1", "app", "Pinned Query", "query");
    const pinnedTab = store.tabs.find((t) => t.id === pinnedId)!;
    pinnedTab.pinned = true;

    const unpinnedId = store.createTab("pg-1", "app", "Regular Query", "query");
    store.closeTab(unpinnedId);

    const reopenedId = store.reopenClosedTab();
    expect(reopenedId).toBeTruthy();

    const group = store.groups[0];
    const pinnedIndex = group.tabIds.indexOf(pinnedId);
    const reopenedIndex = group.tabIds.indexOf(reopenedId!);
    expect(pinnedIndex).toBe(0);
    expect(reopenedIndex).toBeGreaterThan(pinnedIndex);
  });
});
