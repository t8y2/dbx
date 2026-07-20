import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnInfo, QueryResult } from "@/types/database";

function sampleResult(): QueryResult {
  return { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
}

function column(name: string): ColumnInfo {
  return { name, data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null };
}

describe("data tab snapshot restore vs tableMetaPending", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    setActivePinia(createPinia());
  });

  it("does not roll back real metadata to a placeholder snapshot and re-pends placeholder restores", async () => {
    vi.doMock("@/lib/tabs/tabResultCache", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/tabs/tabResultCache")>();
      return {
        ...actual,
        // 延迟元数据期间落盘的快照：空列占位身份
        readTabResultSnapshot: vi.fn(async () => ({ result: sampleResult(), tableMeta: { tableName: "users", schema: "public", columns: [], primaryKeys: [] } }) as any),
      };
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const tabId = store.createTab("pg-1", "app", "users", "data", "public");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    // 真实元数据已在快照落盘后到达并清除 pending
    tab.tableMeta = { tableName: "users", schema: "public", columns: [column("id")], primaryKeys: ["id"] };
    tab.tableMetaPending = false;
    tab.resultEvicted = true;
    tab.resultCacheKey = "cache-key";

    await store.reloadEvictedTab(tabId);

    // 快照确已恢复（防止"恢复根本没发生"导致的误通过）
    expect(tab.result).toBeDefined();
    expect(tab.resultEvicted).toBeUndefined();
    // 快照恢复不得用占位身份回滚真实元数据（否则 pending=false + 空主键 = 编辑门控失效）
    expect(tab.tableMeta?.columns.length).toBe(1);
    expect(tab.tableMeta?.primaryKeys).toEqual(["id"]);
    expect(tab.tableMetaPending).toBe(false);
  });

  it("re-pends the edit gate when a restore leaves only placeholder metadata", async () => {
    vi.doMock("@/lib/tabs/tabResultCache", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/tabs/tabResultCache")>();
      return {
        ...actual,
        readTabResultSnapshot: vi.fn(async () => ({ result: sampleResult(), tableMeta: { tableName: "users", schema: "public", columns: [], primaryKeys: [] } }) as any),
      };
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const tabId = store.createTab("pg-1", "app", "users", "data", "public");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    // 当前也只有占位身份（真实元数据从未落地）
    tab.tableMeta = { tableName: "users", schema: "public", columns: [], primaryKeys: [] };
    tab.tableMetaPending = false;
    tab.resultEvicted = true;
    tab.resultCacheKey = "cache-key";

    await store.reloadEvictedTab(tabId);

    expect(tab.result).toBeDefined();
    // 恢复后行标识仍未知：编辑门控必须重新挂起
    expect(tab.tableMetaPending).toBe(true);
  });
});
