import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DETACHED_TAB_ADOPT_ACK_TIMEOUT_MS,
  getDetachedTabModeFromLocation,
  hasPendingDetachedTabAdoptAck,
  readDetachedTabEntry,
  rejectDetachedTabAdoptAck,
  removeDetachedTabEntry,
  resolveDetachedTabAdoptAck,
  updateDetachedTabSnapshot,
  waitForDetachedTabAdoptAck,
  writeDetachedTabEntry,
  listDetachedTabEntries,
  clearDetachedTabsRegistry,
  detachedTabPlacementKey,
  detachedTabWindowLabel,
  serializeDetachedTab,
  restoreDetachedTabSnapshot,
  type DetachedTabSnapshot,
} from "@/lib/detached/detachedTabs";
import { hasPendingDetachedPanelReady, rejectDetachedPanelReady, resolveDetachedPanelReady, waitForDetachedPanelReady } from "@/lib/detached/detachedPanel";
import type { QueryTab } from "@/types/database";

function stubLocationSearch(search: string) {
  vi.stubGlobal("window", { location: { search } });
}

function stubMemoryLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeTab(overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id: "tab-1",
    title: "query_1",
    connectionId: "conn-1",
    database: "postgres",
    sql: "select 1",
    isExecuting: false,
    mode: "query",
    ...overrides,
  } as QueryTab;
}

function makeSnapshot(overrides: Partial<DetachedTabSnapshot> = {}): DetachedTabSnapshot {
  return {
    id: "tab-1",
    title: "query_1",
    connectionId: "conn-1",
    database: "postgres",
    sql: "select 1",
    mode: "query",
    ...overrides,
  };
}

describe("detachedTabs window mode parsing", () => {
  it("parses direct tab url and shell url", () => {
    stubLocationSearch("");
    expect(getDetachedTabModeFromLocation()).toBeNull();
    stubLocationSearch("?detached-tab=tab-1");
    expect(getDetachedTabModeFromLocation()).toEqual({ kind: "tab", tabId: "tab-1" });
    stubLocationSearch("?detached-tab-shell=1");
    expect(getDetachedTabModeFromLocation()).toEqual({ kind: "shell" });
  });
});

describe("detachedTabs registry", () => {
  beforeEach(() => {
    stubMemoryLocalStorage();
    clearDetachedTabsRegistry();
  });

  it("writes, reads, updates and removes entries", () => {
    writeDetachedTabEntry("tab-1", { snapshot: makeSnapshot(), label: "panel-tab-tab-1", title: "query_1", detachedAt: 1, updatedAt: 1 });
    expect(readDetachedTabEntry("tab-1")?.label).toBe("panel-tab-tab-1");
    expect(listDetachedTabEntries()).toHaveLength(1);

    updateDetachedTabSnapshot("tab-1", makeSnapshot({ sql: "select 2" }));
    const entry = readDetachedTabEntry("tab-1");
    expect(entry?.snapshot.sql).toBe("select 2");
    // 更新快照保留原 label/detachedAt。
    expect(entry?.label).toBe("panel-tab-tab-1");
    expect(entry?.detachedAt).toBe(1);

    removeDetachedTabEntry("tab-1");
    expect(readDetachedTabEntry("tab-1")).toBeNull();
    expect(listDetachedTabEntries()).toHaveLength(0);
  });

  it("updateDetachedTabSnapshot is a no-op for unknown tabs", () => {
    updateDetachedTabSnapshot("missing", makeSnapshot());
    expect(listDetachedTabEntries()).toHaveLength(0);
  });

  it("keeps entries isolated per tab so one writer cannot clobber another tab's entry", () => {
    // 回归：旧版单 key JSON map 下，子窗口防抖同步与主窗口写入并发时会整图覆写丢条目。
    writeDetachedTabEntry("tab-1", { snapshot: makeSnapshot(), label: "panel-tab-tab-1", title: "query_1", detachedAt: 1, updatedAt: 1 });
    writeDetachedTabEntry("tab-2", { snapshot: makeSnapshot({ id: "tab-2" }), label: "panel-tab-tab-2", title: "query_2", detachedAt: 2, updatedAt: 2 });

    // 子窗口同步 tab-1 快照（只触 tab-1 的 key）。
    updateDetachedTabSnapshot("tab-1", makeSnapshot({ sql: "select 9" }));
    // 主窗口随后移除 tab-2（dock）。
    removeDetachedTabEntry("tab-2");

    const remaining = listDetachedTabEntries();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.label).toBe("panel-tab-tab-1");
    expect(remaining[0]?.snapshot.sql).toBe("select 9");
  });

  it("migrates the legacy single-key registry into per-tab keys on list", () => {
    const store = stubMemoryLocalStorage();
    store.set(
      "dbx-detached-tabs-registry",
      JSON.stringify({
        "tab-legacy": { snapshot: makeSnapshot({ id: "tab-legacy" }), label: "panel-tab-tab-legacy", title: "legacy", detachedAt: 1, updatedAt: 1 },
      }),
    );

    const entries = listDetachedTabEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("panel-tab-tab-legacy");
    // 旧 key 已迁移并清除，后续读写走按页签分 key。
    expect(store.has("dbx-detached-tabs-registry")).toBe(false);
    expect(readDetachedTabEntry("tab-legacy")?.title).toBe("legacy");
    removeDetachedTabEntry("tab-legacy");
    expect(listDetachedTabEntries()).toHaveLength(0);
  });

  it("sanitizes window labels and scopes placement keys per tab", () => {
    expect(detachedTabWindowLabel("tab:objects/1")).toBe("panel-tab-tab-objects-1");
    expect(detachedTabPlacementKey("tab:objects/1")).toBe("tab-tab:objects/1");
  });
});

describe("detachedTabs snapshot round-trip", () => {
  it("carries structure draft and editor state through serialization", () => {
    const tab = makeTab({
      mode: "structure",
      structureTableName: "users",
      structureDraft: { comment: "draft" } as unknown as QueryTab["structureDraft"],
      tableInfoTab: "columns",
      editorViewport: { scrollTop: 10, scrollLeft: 0 },
      editorSelection: { anchor: 1, head: 2 },
    });
    const snapshot = serializeDetachedTab(tab);
    expect(snapshot.structureDraft).toEqual({ comment: "draft" });
    expect(snapshot.tableInfoTab).toBe("columns");
    expect(snapshot.editorViewport).toEqual({ scrollTop: 10, scrollLeft: 0 });
    expect(snapshot.editorSelection).toEqual({ anchor: 1, head: 2 });

    const restored = restoreDetachedTabSnapshot(snapshot);
    expect(restored?.structureDraft).toEqual({ comment: "draft" });
    expect(restored?.tableInfoTab).toBe("columns");
    expect(restored?.editorViewport).toEqual({ scrollTop: 10, scrollLeft: 0 });
    expect(restored?.editorSelection).toEqual({ anchor: 1, head: 2 });
    expect(restored?.isExecuting).toBe(false);
  });

  it("forces resultCacheKey + evicted marker for non-data tabs so restore reads from the result cache", () => {
    const tab = makeTab({ resultCacheKey: "cache-key-1" });
    const snapshot = serializeDetachedTab(tab);
    expect(snapshot.resultCacheKey).toBe("cache-key-1");
    expect(snapshot.resultEvicted).toBe(true);

    const restored = restoreDetachedTabSnapshot(snapshot);
    expect(restored?.resultCacheKey).toBe("cache-key-1");
    expect(restored?.resultCacheState).toBe("disk");
  });

  it("carries resultCacheKey for data tabs too so detached windows keep loaded data", () => {
    const tab = makeTab({ mode: "data", resultCacheKey: "cache-key-1" });
    const snapshot = serializeDetachedTab(tab);
    expect(snapshot.resultCacheKey).toBe("cache-key-1");
    expect(snapshot.resultEvicted).toBe(true);

    const restored = restoreDetachedTabSnapshot(snapshot);
    expect(restored?.resultCacheKey).toBe("cache-key-1");
    expect(restored?.resultCacheState).toBe("disk");
    expect(restored?.resultEvicted).toBe(true);
  });

  it("keeps DataGrid pending changes attached to the snapshot through JSON round-trip", () => {
    // dataGridPending 由调用方在序列化后附加（窗口级缓存现取）；快照必须能承载它往返。
    const snapshot = makeSnapshot({
      dataGridPending: {
        "tab-1": {
          newRows: [["Ada", null]],
          newRowMeta: [{ token: 1, placement: null, sourceIndex: undefined, editedColumns: [0] }],
          dirtyRows: [[0, [[1, "Grace"]]]],
          deletedRows: [2],
          editingCell: null,
          transactionActive: true,
          columnCount: 2,
          rowCount: 3,
        },
      },
    });
    const roundTripped = JSON.parse(JSON.stringify(snapshot)) as DetachedTabSnapshot;
    expect(roundTripped.dataGridPending?.["tab-1"]?.newRows).toEqual([["Ada", null]]);
    expect(roundTripped.dataGridPending?.["tab-1"]?.dirtyRows).toEqual([[0, [[1, "Grace"]]]]);
    expect(roundTripped.dataGridPending?.["tab-1"]?.deletedRows).toEqual([2]);
    expect(roundTripped.dataGridPending?.["tab-1"]?.transactionActive).toBe(true);
  });
});

describe("detached tab adopt ack", () => {
  it("resolves the pending wait when the child window confirms adoption", async () => {
    const wait = waitForDetachedTabAdoptAck("tab-1", "panel-tab-tab-1");
    expect(hasPendingDetachedTabAdoptAck("tab-1")).toBe(true);
    resolveDetachedTabAdoptAck("tab-1", "panel-tab-tab-1");
    await expect(wait).resolves.toBeUndefined();
    expect(hasPendingDetachedTabAdoptAck("tab-1")).toBe(false);
  });

  it("rejects the pending wait when the child window reports adopt failure", async () => {
    const wait = waitForDetachedTabAdoptAck("tab-1", "panel-tab-tab-1");
    rejectDetachedTabAdoptAck("tab-1", "restore-failed", "panel-tab-tab-1");
    await expect(wait).rejects.toThrow("restore-failed");
    expect(hasPendingDetachedTabAdoptAck("tab-1")).toBe(false);
  });

  it("rejects the pending wait on timeout so the caller can roll back", async () => {
    vi.useFakeTimers();
    try {
      const wait = waitForDetachedTabAdoptAck("tab-1", "panel-tab-tab-1");
      const assertion = expect(wait).rejects.toThrow(/timeout/);
      await vi.advanceTimersByTimeAsync(DETACHED_TAB_ADOPT_ACK_TIMEOUT_MS + 1);
      await assertion;
      expect(hasPendingDetachedTabAdoptAck("tab-1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("supersedes a stale wait when the same tab is detached again", async () => {
    const first = waitForDetachedTabAdoptAck("tab-1", "panel-tab-tab-1");
    const superseded = expect(first).rejects.toThrow(/superseded/);
    const second = waitForDetachedTabAdoptAck("tab-1", "panel-tab-tab-1");
    await superseded;
    resolveDetachedTabAdoptAck("tab-1", "panel-tab-tab-1");
    await expect(second).resolves.toBeUndefined();
  });

  it("ignores an adopt ack from a stale window attempt", async () => {
    const wait = waitForDetachedTabAdoptAck("tab-1", "panel-tab-current");
    resolveDetachedTabAdoptAck("tab-1", "panel-tab-stale");
    expect(hasPendingDetachedTabAdoptAck("tab-1")).toBe(true);
    rejectDetachedTabAdoptAck("tab-1", "current failed", "panel-tab-current");
    await expect(wait).rejects.toThrow("current failed");
  });

  it("ignores late or unknown acks without a pending wait", () => {
    expect(() => resolveDetachedTabAdoptAck("missing", "panel-tab-missing")).not.toThrow();
    expect(() => rejectDetachedTabAdoptAck("missing", "late")).not.toThrow();
  });
});

describe("detached panel ready ack", () => {
  it("accepts only the current panel window label", async () => {
    const wait = waitForDetachedPanelReady("ai", "panel-ai-current");
    resolveDetachedPanelReady("ai", "panel-ai-stale");
    expect(hasPendingDetachedPanelReady("ai")).toBe(true);
    resolveDetachedPanelReady("ai", "panel-ai-current");
    await expect(wait).resolves.toBeUndefined();
  });

  it("rejects panel readiness so callers can restore the inline panel", async () => {
    const wait = waitForDetachedPanelReady("history", "panel-history");
    rejectDetachedPanelReady("history", "create failed", "panel-history");
    await expect(wait).rejects.toThrow("create failed");
    expect(hasPendingDetachedPanelReady("history")).toBe(false);
  });
});
