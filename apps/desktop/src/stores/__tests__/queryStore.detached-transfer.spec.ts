import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedOpenTab } from "@/lib/app/openTabsPersistence";

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
  });

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
    let savedPayload: { tabs: SavedOpenTab[]; activeTabId: string | null } | null = null;
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
  });

  it("keeps every concurrent transfer represented in durable open tabs", async () => {
    const savedPayloads: Array<{ tabs: SavedOpenTab[]; activeTabId: string | null }> = [];
    vi.doMock("@/lib/backend/api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/backend/api")>()),
      saveOpenTabsState: vi.fn(async (payload: { tabs: SavedOpenTab[]; activeTabId: string | null }) => {
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
