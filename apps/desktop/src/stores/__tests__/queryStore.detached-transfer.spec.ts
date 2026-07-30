import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { serializeOpenTabs, type SavedOpenTab } from "@/lib/app/openTabsPersistence";

interface SavedOpenTabsPayload {
  tabs: SavedOpenTab[];
  activeTabId: string | null;
  detachedTabOwners?: Array<{ windowLabel: string; tabId: string }>;
}

describe("queryStore detached tab transfer", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    setActivePinia(createPinia());
  });

  it("moves a tab out without clearing its result and restores it on failure", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const firstId = store.createTab("pg-1", "app", "users", "data", "public");
    const secondId = store.createTab("pg-1", "app", "orders", "data", "public");
    const firstTab = store.tabs.find((tab) => tab.id === firstId)!;
    firstTab.result = {
      columns: ["id"],
      rows: [[1]],
      affected_rows: 0,
      execution_time_ms: 1,
    };
    store.switchTab(firstId);

    const transfer = store.takeTabForTransfer(firstId);

    expect(transfer?.tab).toBe(firstTab);
    expect(transfer?.tab.result?.rows).toEqual([[1]]);
    expect(store.tabs.map((tab) => tab.id)).toEqual([secondId]);
    expect(store.activeTabId).toBe(secondId);

    store.restoreTabFromTransfer(transfer!);

    expect(store.tabs.map((tab) => tab.id)).toEqual([firstId, secondId]);
    expect(store.activeTabId).toBe(firstId);
    expect(store.tabs[0].result?.rows).toEqual([[1]]);
  }, 10_000);

  it("adopts exactly one transferred tab as the detached window owner", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const transferredTab = {
      id: "detached-1",
      title: "Query",
      connectionId: "pg-1",
      database: "app",
      sql: "select 1",
      mode: "query" as const,
      isExecuting: false,
      result: {
        columns: ["value"],
        rows: [[1]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    };

    store.adoptTransferredTab(transferredTab);

    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0]).toMatchObject(transferredTab);
    expect(store.activeTabId).toBe(transferredTab.id);
    expect(store.isOpenTabsLoaded).toBe(true);
    expect(() => store.adoptTransferredTab({ ...transferredTab, id: "detached-2" })).toThrow("Detached window already owns a tab");
  });

  it("removes a detached tab through the awaitable close path", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("", "app", "Query", "query");

    const closed = await store.closeTabAndWait(tabId, { force: true });

    expect(closed).toBe(true);
    expect(store.tabs.some((tab) => tab.id === tabId)).toBe(false);
  });

  it("rejects additional tabs after a detached window adopts its owner tab", async () => {
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
    vi.stubGlobal("window", {
      location: { search: "?dbxDetachedTransfer=transfer-1" },
      setTimeout,
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    store.adoptTransferredTab({
      id: "detached-owner",
      title: "Query",
      connectionId: "pg-1",
      database: "app",
      sql: "select 1",
      mode: "query",
      isExecuting: false,
    });

    expect(() => store.createTab("pg-1", "app", "Another query", "query")).toThrow("Detached tab windows cannot create additional tabs");
    expect(store.tabs.map((tab) => tab.id)).toEqual(["detached-owner"]);
  });

  it("replaces the owned tab for explicit detached-window navigation", async () => {
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
    vi.stubGlobal("window", {
      location: { search: "?dbxDetachedTransfer=transfer-1" },
      setTimeout,
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    store.adoptTransferredTab({
      id: "detached-owner",
      title: "Query",
      connectionId: "pg-1",
      database: "app",
      sql: "select 1",
      mode: "query",
      isExecuting: false,
    });

    await store.replaceActiveTabForDetachedNavigation({ force: true });
    const replacementId = store.createTab("pg-1", "app", "public.orders", "data", "public", undefined, undefined, { forceNew: true });

    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0]).toMatchObject({
      id: replacementId,
      title: "public.orders",
      mode: "data",
      schema: "public",
    });
    expect(store.tabs[0].id).not.toBe("detached-owner");
    expect(store.activeTabId).toBe(replacementId);
  });

  it("does not replace a dirty detached tab without an explicit decision", async () => {
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
    vi.stubGlobal("window", {
      location: { search: "?dbxDetachedTransfer=transfer-1" },
      setTimeout,
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    store.adoptTransferredTab({
      id: "detached-dirty",
      title: "Query",
      connectionId: "pg-1",
      database: "app",
      sql: "select 2",
      originalSql: "select 1",
      mode: "query",
      isExecuting: false,
    });

    const replaced = await store.replaceActiveTabForDetachedNavigation();

    expect(replaced).toBe(false);
    expect(store.showCloseConfirm).toBe(true);
    expect(store.pendingCloseTabId).toBe("detached-dirty");
    expect(store.tabs.map((tab) => tab.id)).toEqual(["detached-dirty"]);
  });

  it("persists detached owners in the main document and restores them after restart", async () => {
    let savedPayload: SavedOpenTabsPayload | null = null;
    const loadOpenTabsState = vi.fn(async () => savedPayload);
    const saveOpenTabsState = vi.fn(async (payload: typeof savedPayload) => {
      savedPayload = payload;
    });
    vi.doMock("@/lib/backend/api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/backend/api")>()),
      loadOpenTabsState,
      saveOpenTabsState,
    }));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const detachedId = store.createTab("pg-1", "app", "Detached", "query", undefined, "select 42");
    const mainId = store.createTab("pg-1", "app", "Main", "query", undefined, "select 1");
    const transfer = store.takeTabForTransfer(detachedId)!;
    transfer.tab.pinned = true;
    transfer.tab.schema = "public";
    transfer.tab.tableMeta = {
      schema: "public",
      tableName: "orders",
      columns: [],
      primaryKeys: [],
    };
    store.registerDetachedOpenTab("detached-tab-1", transfer.tab);
    store.registerDetachedOpenTab("detached-tab-stale", transfer.tab);
    store.updateDetachedOpenTab("detached-tab-stale", serializeOpenTabs([transfer.tab])[0]!);

    await store.flushPendingPersist({ force: true });

    expect(savedPayload?.tabs.map((tab) => tab.id)).toEqual([mainId, detachedId]);
    expect(savedPayload?.tabs.find((tab) => tab.id === detachedId)?.sql).toBe("select 42");
    expect(savedPayload?.tabs.find((tab) => tab.id === detachedId)).toMatchObject({
      pinned: true,
      schema: "public",
      tableMeta: {
        schema: "public",
        tableName: "orders",
      },
    });
    expect(savedPayload?.detachedTabOwners).toEqual([{ windowLabel: "detached-tab-stale", tabId: detachedId }]);

    setActivePinia(createPinia());
    const restoredStore = useQueryStore();
    await restoredStore.initOpenTabs();

    expect(restoredStore.tabs.map((tab) => tab.id)).toEqual([mainId, detachedId]);
    expect(restoredStore.tabs.find((tab) => tab.id === detachedId)).toMatchObject({
      pinned: true,
      schema: "public",
      tableMeta: {
        schema: "public",
        tableName: "orders",
      },
    });
    await restoredStore.flushPendingPersist({ force: true });
    expect(savedPayload?.detachedTabOwners).toEqual([]);
  });

  it("keeps the live detached snapshot authoritative when only the main store reloads", async () => {
    let savedPayload: SavedOpenTabsPayload | null = null;
    const loadOpenTabsState = vi.fn(async () => savedPayload);
    const saveOpenTabsState = vi.fn(async (payload: SavedOpenTabsPayload) => {
      savedPayload = structuredClone(payload);
    });
    vi.doMock("@/lib/backend/api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/backend/api")>()),
      loadOpenTabsState,
      saveOpenTabsState,
    }));

    const { useQueryStore } = await import("@/stores/queryStore");
    const sourceStore = useQueryStore();
    const detachedId = sourceStore.createTab("pg-1", "app", "Detached", "query", undefined, "select 'old'");
    const transfer = sourceStore.takeTabForTransfer(detachedId)!;
    sourceStore.registerDetachedOpenTab("detached-tab-live", transfer.tab);
    sourceStore.updateDetachedOpenTab("detached-tab-live", serializeOpenTabs([transfer.tab])[0]!);
    await sourceStore.flushPendingPersist({ force: true });

    expect(savedPayload?.detachedTabOwners).toEqual([{ windowLabel: "detached-tab-live", tabId: detachedId }]);

    setActivePinia(createPinia());
    const reloadedMainStore = useQueryStore();
    await reloadedMainStore.initOpenTabs({ detachedWindowLabels: ["detached-tab-live"] });

    expect(reloadedMainStore.tabs.some((tab) => tab.id === detachedId)).toBe(false);

    const childSnapshot = {
      ...savedPayload!.tabs.find((tab) => tab.id === detachedId)!,
      title: "Detached updated",
      sql: "select 'new'",
      pinned: true,
    };
    reloadedMainStore.updateDetachedOpenTab("detached-tab-live", childSnapshot);
    await reloadedMainStore.flushPendingPersist({ force: true });

    expect(savedPayload!.tabs.filter((tab) => tab.id === detachedId)).toHaveLength(1);
    expect(savedPayload!.tabs.find((tab) => tab.id === detachedId)).toMatchObject(childSnapshot);
    expect(savedPayload!.detachedTabOwners).toEqual([{ windowLabel: "detached-tab-live", tabId: detachedId }]);
    expect(reloadedMainStore.tabs.some((tab) => tab.id === detachedId)).toBe(false);
  });

  it("waits for main-tab restoration before acknowledging an early child update", async () => {
    const mainTab: SavedOpenTab = {
      id: "main-1",
      title: "Main",
      connectionId: "pg-1",
      database: "app",
      sql: "select 'main'",
      mode: "query",
    };
    const oldChildTab: SavedOpenTab = {
      id: "detached-1",
      title: "Detached",
      connectionId: "pg-1",
      database: "app",
      sql: "select 'old'",
      mode: "query",
    };
    let savedPayload: SavedOpenTabsPayload = {
      tabs: [mainTab, oldChildTab],
      activeTabId: mainTab.id,
      detachedTabOwners: [{ windowLabel: "detached-tab-live", tabId: oldChildTab.id }],
    };
    const saveOpenTabsState = vi.fn(async (payload: SavedOpenTabsPayload) => {
      savedPayload = structuredClone(payload);
    });
    vi.doMock("@/lib/backend/api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/backend/api")>()),
      loadOpenTabsState: vi.fn(async () => structuredClone(savedPayload)),
      saveOpenTabsState,
    }));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    store.updateDetachedOpenTab("detached-tab-live", {
      ...oldChildTab,
      sql: "select 'new'",
      pinned: true,
    });
    const pendingFlush = store.flushPendingPersist({ force: true, waitForOpenTabsLoad: true });
    await Promise.resolve();
    expect(saveOpenTabsState).not.toHaveBeenCalled();

    await store.initOpenTabs({ detachedWindowLabels: ["detached-tab-live"] });
    await pendingFlush;

    expect(store.tabs.map((tab) => tab.id)).toEqual([mainTab.id]);
    expect(savedPayload.tabs.map((tab) => tab.id)).toEqual([mainTab.id, oldChildTab.id]);
    expect(savedPayload.tabs.find((tab) => tab.id === oldChildTab.id)).toMatchObject({
      sql: "select 'new'",
      pinned: true,
    });
  });

  it("does not resurrect a child closed while the recreated main store is loading", async () => {
    const closedChildTab: SavedOpenTab = {
      id: "detached-closed",
      title: "Detached",
      connectionId: "pg-1",
      database: "app",
      sql: "select 1",
      mode: "query",
    };
    let savedPayload: SavedOpenTabsPayload = {
      tabs: [closedChildTab],
      activeTabId: null,
      detachedTabOwners: [{ windowLabel: "detached-tab-closing", tabId: closedChildTab.id }],
    };
    vi.doMock("@/lib/backend/api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/backend/api")>()),
      loadOpenTabsState: vi.fn(async () => structuredClone(savedPayload)),
      saveOpenTabsState: vi.fn(async (payload: SavedOpenTabsPayload) => {
        savedPayload = structuredClone(payload);
      }),
    }));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    store.removeDetachedOpenTab("detached-tab-closing");
    const pendingFlush = store.flushPendingPersist({ force: true, waitForOpenTabsLoad: true });

    await store.initOpenTabs({ detachedWindowLabels: [] });
    await pendingFlush;

    expect(store.tabs).toEqual([]);
    expect(savedPayload.tabs).toEqual([]);
    expect(savedPayload.detachedTabOwners).toEqual([]);
  });

  it("removes an orphan restored just before the child close report arrives", async () => {
    const closingChildTab: SavedOpenTab = {
      id: "detached-late-close",
      title: "Detached",
      connectionId: "pg-1",
      database: "app",
      sql: "select 1",
      mode: "query",
    };
    let savedPayload: SavedOpenTabsPayload = {
      tabs: [closingChildTab],
      activeTabId: null,
      detachedTabOwners: [{ windowLabel: "detached-tab-late-close", tabId: closingChildTab.id }],
    };
    vi.doMock("@/lib/backend/api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/backend/api")>()),
      loadOpenTabsState: vi.fn(async () => structuredClone(savedPayload)),
      saveOpenTabsState: vi.fn(async (payload: SavedOpenTabsPayload) => {
        savedPayload = structuredClone(payload);
      }),
    }));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    await store.initOpenTabs({ detachedWindowLabels: [] });
    expect(store.tabs.map((tab) => tab.id)).toEqual([closingChildTab.id]);

    // Older child runtimes omit removedTabId; persisted ownership still identifies
    // the orphan that must not be resurrected in main.
    store.removeDetachedOpenTab("detached-tab-late-close");
    await store.flushPendingPersist({ force: true });

    expect(store.tabs).toEqual([]);
    expect(savedPayload.tabs).toEqual([]);
    expect(savedPayload.detachedTabOwners).toEqual([]);
  });

  it("removes a legacy main-store duplicate when the live child reports ownership", async () => {
    const detachedTab: SavedOpenTab = {
      id: "legacy-detached",
      title: "Detached",
      connectionId: "pg-1",
      database: "app",
      sql: "select 'old'",
      mode: "query",
    };
    let savedPayload: SavedOpenTabsPayload = {
      tabs: [detachedTab],
      activeTabId: detachedTab.id,
    };
    vi.doMock("@/lib/backend/api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/backend/api")>()),
      loadOpenTabsState: vi.fn(async () => structuredClone(savedPayload)),
      saveOpenTabsState: vi.fn(async (payload: SavedOpenTabsPayload) => {
        savedPayload = structuredClone(payload);
      }),
    }));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    await store.initOpenTabs({ detachedWindowLabels: ["detached-tab-live"] });
    expect(store.tabs.map((tab) => tab.id)).toEqual([detachedTab.id]);

    store.updateDetachedOpenTab("detached-tab-live", {
      ...detachedTab,
      sql: "select 'child'",
    });
    await store.flushPendingPersist({ force: true });

    expect(store.tabs.some((tab) => tab.id === detachedTab.id)).toBe(false);
    expect(savedPayload.tabs).toEqual([
      expect.objectContaining({
        id: detachedTab.id,
        sql: "select 'child'",
      }),
    ]);
    expect(savedPayload.detachedTabOwners).toEqual([{ windowLabel: "detached-tab-live", tabId: detachedTab.id }]);
  });

  it("keeps provisional transfers recoverable by main after a WebView reload", async () => {
    let savedPayload: SavedOpenTabsPayload | null = null;
    vi.doMock("@/lib/backend/api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/backend/api")>()),
      loadOpenTabsState: vi.fn(async () => savedPayload),
      saveOpenTabsState: vi.fn(async (payload: SavedOpenTabsPayload) => {
        savedPayload = structuredClone(payload);
      }),
    }));

    const { useQueryStore } = await import("@/stores/queryStore");
    const sourceStore = useQueryStore();
    const tabId = sourceStore.createTab("pg-1", "app", "Provisional", "query", undefined, "select 1");
    const transfer = sourceStore.takeTabForTransfer(tabId)!;
    sourceStore.registerDetachedOpenTab("detached-tab-provisional", transfer.tab);
    await sourceStore.flushPendingPersist({ force: true });

    expect(savedPayload?.detachedTabOwners).toEqual([]);

    setActivePinia(createPinia());
    const reloadedMainStore = useQueryStore();
    await reloadedMainStore.initOpenTabs({ detachedWindowLabels: ["detached-tab-provisional"] });

    expect(reloadedMainStore.tabs.map((tab) => tab.id)).toEqual([tabId]);
  });

  it("preserves persisted detached owners when live-window enumeration is unknown", async () => {
    const detachedTab: SavedOpenTab = {
      id: "detached-unknown",
      title: "Detached",
      connectionId: "pg-1",
      database: "app",
      sql: "select 1",
      mode: "query",
    };
    let savedPayload: SavedOpenTabsPayload | null = null;
    vi.doMock("@/lib/backend/api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/backend/api")>()),
      loadOpenTabsState: vi.fn(async () => ({
        tabs: [detachedTab],
        activeTabId: null,
        detachedTabOwners: [{ windowLabel: "detached-tab-unknown", tabId: detachedTab.id }],
      })),
      saveOpenTabsState: vi.fn(async (payload: SavedOpenTabsPayload) => {
        savedPayload = structuredClone(payload);
      }),
    }));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    await store.initOpenTabs({ detachedWindowLabels: null });

    expect(store.tabs).toEqual([]);
    await store.flushPendingPersist({ force: true });
    expect(savedPayload?.detachedTabOwners).toEqual([{ windowLabel: "detached-tab-unknown", tabId: detachedTab.id }]);
  });

  it("keeps detached result-cache keys live during main-store maintenance", async () => {
    const pruneTabResultSnapshots = vi.fn(async () => {});
    vi.doMock("@/lib/tabs/tabResultCache", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/tabs/tabResultCache")>()),
      pruneTabResultSnapshots,
    }));
    vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
      callback();
      return 1;
    });
    const detachedTab: SavedOpenTab = {
      id: "detached-cache",
      title: "Detached",
      connectionId: "pg-1",
      database: "app",
      sql: "select 1",
      mode: "query",
      resultCacheKey: "tab-result:detached-cache",
      resultRuns: [
        {
          id: "run-1",
          title: "Result 1",
          sequence: 1,
          sql: "select 1",
          createdAt: 1,
          resultCacheKey: "tab-result:detached-cache:run-1",
        },
      ],
    };
    vi.doMock("@/lib/backend/api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/backend/api")>()),
      loadOpenTabsState: vi.fn(async () => ({
        tabs: [detachedTab],
        activeTabId: null,
        detachedTabOwners: [{ windowLabel: "detached-tab-cache", tabId: detachedTab.id }],
      })),
    }));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    await store.initOpenTabs({ detachedWindowLabels: ["detached-tab-cache"] });

    expect(pruneTabResultSnapshots).toHaveBeenCalledWith(["tab-result:detached-cache", "tab-result:detached-cache:run-1"]);
  });

  it("does not treat a persisted-state read failure as an empty document", async () => {
    const saveOpenTabsState = vi.fn();
    vi.doMock("@/lib/backend/api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/backend/api")>()),
      loadOpenTabsState: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
      saveOpenTabsState,
    }));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    await expect(store.initOpenTabs()).rejects.toThrow("storage unavailable");
    expect(store.isOpenTabsLoaded).toBe(false);
    expect(saveOpenTabsState).not.toHaveBeenCalled();
  });

  it("keeps every concurrent transfer represented in durable open tabs", async () => {
    const savedPayloads: SavedOpenTabsPayload[] = [];
    vi.doMock("@/lib/backend/api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/backend/api")>()),
      saveOpenTabsState: vi.fn(async (payload: SavedOpenTabsPayload) => {
        savedPayloads.push(payload);
      }),
    }));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const firstId = store.createTab("pg-1", "app", "First", "query", undefined, "select 1");
    const secondId = store.createTab("pg-1", "app", "Second", "query", undefined, "select 2");

    store.suspendOpenTabsPersist();
    const firstTransfer = store.takeTabForTransfer(firstId)!;
    store.registerDetachedOpenTab("detached-first", firstTransfer.tab);
    await store.flushPendingPersist({ force: true });

    store.suspendOpenTabsPersist();
    const secondTransfer = store.takeTabForTransfer(secondId)!;
    store.registerDetachedOpenTab("detached-second", secondTransfer.tab);
    await store.flushPendingPersist({ force: true });

    expect(savedPayloads).toHaveLength(2);
    expect(savedPayloads[0].tabs.map((tab) => tab.id)).toEqual([secondId, firstId]);
    expect(savedPayloads[1].tabs.map((tab) => tab.id)).toEqual([firstId, secondId]);
  });

  it("does not release tab sessions while ownership is transferred or restored", async () => {
    const closeQuerySession = vi.fn();
    const closeClientConnectionSession = vi.fn();
    vi.doMock("@/lib/backend/api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/backend/api")>()),
      closeQuerySession,
      closeClientConnectionSession,
    }));

    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "Query", "query");
    const tab = store.tabs[0];
    tab.resultSessionId = "result-session-1";
    tab.clientSessionId = "client-session-1";

    const transfer = store.takeTabForTransfer(tabId)!;
    store.restoreTabFromTransfer(transfer);
    await Promise.resolve();

    expect(closeQuerySession).not.toHaveBeenCalled();
    expect(closeClientConnectionSession).not.toHaveBeenCalled();
    expect(store.tabs[0].resultSessionId).toBe("result-session-1");
    expect(store.tabs[0].clientSessionId).toBe("client-session-1");
  });
});
