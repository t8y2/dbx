import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 10_000 });

// The detach chain must never touch the persistence transport: adopting a
// handoff is an in-memory store transition; the file only moves via
// saveDetachedTabHandoff in App-level code, which these tests do not drive.
vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    loadOpenTabsState: vi.fn(() => Promise.resolve(null)),
    saveOpenTabsState: vi.fn(() => Promise.resolve()),
    saveDetachedTabHandoff: vi.fn(() => Promise.resolve()),
    deleteDetachedTabHandoff: vi.fn(() => Promise.resolve()),
  };
});

describe("queryStore detached-tab handoff", () => {
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

  async function makeHandoff() {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "Query 1", "query");
    // A result-less query tab keeps prepareDetachedTab off the backend cache.
    const handoff = await store.prepareDetachedTab(tabId);
    return { store, tabId, handoff };
  }

  it("adopting a handoff lands the tab in the main pane so the split workspace can render it", async () => {
    const { handoff } = await makeHandoff();

    // Fresh store = the detached window's store before adoption.
    setActivePinia(createPinia());
    const { useQueryStore } = await import("@/stores/queryStore");
    const freshStore = useQueryStore();
    expect(freshStore.tabs).toHaveLength(0);

    await freshStore.adoptDetachedTab(handoff);

    expect(freshStore.tabs.map((tab) => tab.id)).toEqual([handoff.tabId]);
    // Without group membership the workspace renders the empty-group
    // placeholder regardless of tabs/activeTabId — membership is the fix.
    expect(freshStore.groups[0]?.tabIds).toEqual([handoff.tabId]);
    expect(freshStore.groups[0]?.activeTabId).toBe(handoff.tabId);
    expect(freshStore.activeTabId).toBe(handoff.tabId);
    expect(freshStore.focusedGroupId).toBe(freshStore.groups[0]?.id);
  });

  it("keeps read-only source intent across detached-window handoff", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("pg-1", "app", "Source - seq_users", "query", "public", "CREATE SEQUENCE seq_users", undefined, { sourceView: true });
    const handoff = await store.prepareDetachedTab(id);
    expect(handoff.tab.sourceView).toBe(true);
    setActivePinia(createPinia());
    const detachedStore = useQueryStore();
    await detachedStore.adoptDetachedTab(handoff);
    expect(detachedStore.tabs[0]?.sourceView).toBe(true);
    expect(detachedStore.tabs[0]?.objectSource).toBeUndefined();
  });

  it("removeTabAfterDetachedReady clears the owning pane and prunes it when emptied", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const mainTabId = store.createTab("pg-1", "app", "Query 1", "query");
    const detachedTabId = store.createTab("pg-1", "app", "Query 2", "query");
    store.splitTabRight(detachedTabId);
    expect(store.groups).toHaveLength(2);
    store.activateTab(detachedTabId);

    expect(store.removeTabAfterDetachedReady(detachedTabId)).toBe(true);

    // No dangling group entry: the emptied pane is pruned, the main pane and
    // its tab survive, and the global active tab re-syncs to a live tab.
    expect(store.tabs.map((tab) => tab.id)).toEqual([mainTabId]);
    expect(store.groups).toHaveLength(1);
    expect(store.groups[0]?.tabIds).toEqual([mainTabId]);
    expect(store.activeTabId).toBe(mainTabId);
  });

  it("returning a detached tab re-homes it into the workspace after its pane was pruned", async () => {
    const { store, tabId, handoff } = await makeHandoff();
    store.activateTab(tabId);
    store.removeTabAfterDetachedReady(tabId);
    expect(store.tabs).toHaveLength(0);

    await store.adoptDetachedTab(handoff);

    expect(store.tabs.map((tab) => tab.id)).toEqual([tabId]);
    expect(store.groups[0]?.tabIds).toEqual([tabId]);
    expect(store.activeTabId).toBe(tabId);
  });

  it("re-adopting the same handoff does not duplicate the tab or its group entry", async () => {
    const { handoff } = await makeHandoff();

    setActivePinia(createPinia());
    const { useQueryStore } = await import("@/stores/queryStore");
    const freshStore = useQueryStore();
    await freshStore.adoptDetachedTab(handoff);
    await freshStore.adoptDetachedTab(handoff);

    expect(freshStore.tabs).toHaveLength(1);
    expect(freshStore.groups[0]?.tabIds).toEqual([handoff.tabId]);
    expect(freshStore.activeTabId).toBe(handoff.tabId);
  });
});
