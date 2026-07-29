import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    vi.stubGlobal("window", { location: { search: "?dbxDetachedTransfer=transfer-1" } });
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
});
