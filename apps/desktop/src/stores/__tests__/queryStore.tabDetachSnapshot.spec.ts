import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";

function sampleResult(): QueryResult {
  return { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
}

describe("prepareTabDetachSnapshot keeps result cache references", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    setActivePinia(createPinia());
  });

  async function setupStoreWithCacheWrite() {
    vi.doMock("@/lib/tabs/tabResultCache", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/tabs/tabResultCache")>();
      return {
        ...actual,
        writeTabResultSnapshot: vi.fn(async () => true),
      };
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const { restoreDetachedTabSnapshot } = await import("@/lib/detached/detachedTabs");
    return { store: useQueryStore(), restoreDetachedTabSnapshot };
  }

  it("carries resultCacheKey for data tabs so the detached window reads data back from cache", async () => {
    const { store, restoreDetachedTabSnapshot } = await setupStoreWithCacheWrite();
    const tabId = store.createTab("pg-1", "app", "users", "data", "public");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.result = sampleResult();

    const snapshot = await store.prepareTabDetachSnapshot(tabId);
    expect(snapshot).toBeDefined();
    expect(snapshot?.resultCacheKey).toBe(`tab:${tabId}:result`);
    expect(snapshot?.resultEvicted).toBe(true);

    // 子窗口侧恢复：缓存引用必须保留，否则数据变成"需要重新加载"。
    const restored = restoreDetachedTabSnapshot(snapshot!);
    expect(restored?.mode).toBe("data");
    expect(restored?.resultCacheKey).toBe(`tab:${tabId}:result`);
    expect(restored?.resultEvicted).toBe(true);
    expect(restored?.resultCacheState).toBe("disk");
  });

  it("carries resultCacheKey for query tabs with live results", async () => {
    const { store, restoreDetachedTabSnapshot } = await setupStoreWithCacheWrite();
    const tabId = store.createTab("pg-1", "app", "query_1", "query", "public", "select 1");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.result = sampleResult();
    tab.lastExecutedSql = "select 1";

    const snapshot = await store.prepareTabDetachSnapshot(tabId);
    expect(snapshot?.resultCacheKey).toBe(`tab:${tabId}:result`);
    expect(snapshot?.resultEvicted).toBe(true);

    const restored = restoreDetachedTabSnapshot(snapshot!);
    expect(restored?.resultCacheKey).toBe(`tab:${tabId}:result`);
    expect(restored?.resultEvicted).toBe(true);
    expect(restored?.resultCacheState).toBe("disk");
  });

  it("does not mark tabs without results as evicted", async () => {
    const { store } = await setupStoreWithCacheWrite();
    const tabId = store.createTab("pg-1", "app", "query_1", "query", "public", "select 1");

    const snapshot = await store.prepareTabDetachSnapshot(tabId);
    expect(snapshot?.resultCacheKey).toBeUndefined();
    expect(snapshot?.resultEvicted).toBeUndefined();
  });

  it("attaches DataGrid pending changes to the detach snapshot", async () => {
    const { store } = await setupStoreWithCacheWrite();
    const { stageDataGridPendingSnapshotsForTab } = await import("@/composables/useDataGridEditor");
    const tabId = store.createTab("pg-1", "app", "users", "data", "public");
    // 模拟主窗口 DataGrid 的未保存编辑（正常由 grid 经 pendingChangesCache 写入）。
    stageDataGridPendingSnapshotsForTab(tabId, {
      [tabId]: {
        newRows: [["Ada"]],
        newRowMeta: [{ token: 1, placement: null }],
        dirtyRows: [[0, [[0, "Grace"]]]],
        deletedRows: [1],
        editingCell: null,
        columnCount: 1,
        rowCount: 2,
      },
    });

    const snapshot = await store.prepareTabDetachSnapshot(tabId);
    expect(snapshot?.dataGridPending?.[tabId]?.newRows).toEqual([["Ada"]]);
    expect(snapshot?.dataGridPending?.[tabId]?.dirtyRows).toEqual([[0, [[0, "Grace"]]]]);
    expect(snapshot?.dataGridPending?.[tabId]?.deletedRows).toEqual([1]);
    // registry 经 localStorage JSON 交换：快照必须可 JSON 往返。
    const roundTripped = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    expect(roundTripped?.dataGridPending?.[tabId]?.newRows).toEqual([["Ada"]]);
  });

  it("omits dataGridPending when the tab has no pending grid changes", async () => {
    const { store } = await setupStoreWithCacheWrite();
    const tabId = store.createTab("pg-1", "app", "query_1", "query", "public", "select 1");

    const snapshot = await store.prepareTabDetachSnapshot(tabId);
    expect(snapshot?.dataGridPending).toBeUndefined();
  });
});

describe("concealTabForDetach freezes the tab before snapshot collection", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    setActivePinia(createPinia());
  });

  async function setupStore() {
    const { useQueryStore } = await import("@/stores/queryStore");
    return useQueryStore();
  }

  it("hides the tab and moves activation away so it can no longer be edited", async () => {
    const store = await setupStore();
    const firstId = store.createTab("pg-1", "app", "query_1", "query", "public", "select 1");
    const secondId = store.createTab("pg-1", "app", "users", "data", "public");
    expect(store.activeTabId).toBe(secondId);

    store.concealTabForDetach(secondId);
    const tab = store.tabs.find((item) => item.id === secondId)!;
    expect(tab.pendingDetach).toBe(true);
    expect(store.activeTabId).toBe(firstId);
  });

  it("keeps the current active tab when concealing an inactive tab", async () => {
    const store = await setupStore();
    const firstId = store.createTab("pg-1", "app", "query_1", "query", "public", "select 1");
    const secondId = store.createTab("pg-1", "app", "users", "data", "public");
    store.switchTab(secondId);
    store.switchTab(firstId);

    store.concealTabForDetach(secondId);
    expect(store.activeTabId).toBe(firstId);
  });

  it("is a no-op for tabs already marked pendingDetach (new-tab detach flows)", async () => {
    const store = await setupStore();
    const firstId = store.createTab("pg-1", "app", "query_1", "query", "public", "select 1");
    const hiddenId = store.createTab("pg-1", "app", "users", "data", "public", undefined, undefined, { activate: false, pendingDetach: true });
    expect(store.activeTabId).toBe(firstId);

    store.concealTabForDetach(hiddenId);
    expect(store.activeTabId).toBe(firstId);
    expect(store.tabs.find((item) => item.id === hiddenId)?.pendingDetach).toBe(true);
  });

  it("revealPendingDetachTab restores visibility and activation after conceal", async () => {
    const store = await setupStore();
    const firstId = store.createTab("pg-1", "app", "query_1", "query", "public", "select 1");
    const secondId = store.createTab("pg-1", "app", "users", "data", "public");

    store.concealTabForDetach(secondId);
    expect(store.activeTabId).toBe(firstId);
    store.revealPendingDetachTab(secondId);
    const tab = store.tabs.find((item) => item.id === secondId)!;
    expect(tab.pendingDetach).toBeUndefined();
    expect(store.activeTabId).toBe(secondId);
  });

  it("still collects pre-conceal grid edits into the snapshot (state survives conceal)", async () => {
    vi.doMock("@/lib/tabs/tabResultCache", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/tabs/tabResultCache")>();
      return { ...actual, writeTabResultSnapshot: vi.fn(async () => true) };
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const { stageDataGridPendingSnapshotsForTab } = await import("@/composables/useDataGridEditor");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "users", "data", "public");
    stageDataGridPendingSnapshotsForTab(tabId, {
      [tabId]: {
        newRows: [["Ada"]],
        newRowMeta: [{ token: 1, placement: null }],
        dirtyRows: [],
        deletedRows: [],
        editingCell: null,
        columnCount: 1,
        rowCount: 2,
      },
    });

    store.concealTabForDetach(tabId);
    const snapshot = await store.prepareTabDetachSnapshot(tabId);
    expect(snapshot?.dataGridPending?.[tabId]?.newRows).toEqual([["Ada"]]);
  });
});
