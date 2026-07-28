import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";

function sampleResult(rows: number): QueryResult {
  return {
    columns: ["id", "name"],
    rows: Array.from({ length: rows }, (_, index) => [index, `row-${index}`]),
    affected_rows: 0,
    execution_time_ms: 1,
  };
}

describe("queryStore touchResult estimated bytes reuse", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    setActivePinia(createPinia());
  });

  it("reuses the cached byte estimate when switching tabs", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const tab1Id = store.createTab("pg-1", "app", "first", "query");
    const tab2Id = store.createTab("pg-1", "app", "second", "query");
    const tab1 = store.tabs.find((tab) => tab.id === tab1Id)!;
    tab1.result = sampleResult(50);
    tab1.resultEstimatedBytes = 987654;
    const previousAccessedAt = 1000;
    tab1.resultAccessedAt = previousAccessedAt;

    store.activeTabId = tab2Id;
    store.activeTabId = tab1Id;

    // 切页只应更新访问时间，不应深遍历结果集重算字节数
    expect(tab1.resultEstimatedBytes).toBe(987654);
    expect(tab1.resultAccessedAt).toBeGreaterThan(previousAccessedAt);
    expect(tab1.resultCacheState).toBe("memory");
  });

  it("computes the byte estimate on tab switch when it is missing", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const tab1Id = store.createTab("pg-1", "app", "first", "query");
    const tab2Id = store.createTab("pg-1", "app", "second", "query");
    const tab2 = store.tabs.find((tab) => tab.id === tab2Id)!;
    tab2.result = sampleResult(3);
    tab2.resultEstimatedBytes = undefined;

    store.activeTabId = tab1Id;
    store.activeTabId = tab2Id;

    expect(tab2.resultEstimatedBytes).toBeGreaterThan(0);
  });

  it("refreshes the estimate when an error result replaces a large payload", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const tabId = store.createTab("pg-1", "app", "big", "query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.result = sampleResult(5000);
    tab.resultEstimatedBytes = 5_000_000;

    store.setErrorResult(tabId, new Error("boom"));

    // 错误结果替换大负载后估算值必须刷新，否则内存淘汰会按旧的大结果计算
    expect(tab.resultEstimatedBytes).toBeGreaterThan(0);
    expect(tab.resultEstimatedBytes).toBeLessThan(5_000_000);
  });

  it("recomputes the estimate when a result run is restored from disk", async () => {
    const smallResult = sampleResult(2);
    vi.doMock("@/lib/tabs/tabResultCache", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/tabs/tabResultCache")>();
      return {
        ...actual,
        readTabResultSnapshot: vi.fn(async () => ({ resultRuns: [{ id: "run-1", result: smallResult }] }) as any),
      };
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const tabId = store.createTab("pg-1", "app", "runs", "query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.resultRuns = [
      {
        id: "run-1",
        title: "Run 1",
        sequence: 1,
        sql: "select 1",
        createdAt: 1,
        resultCacheKey: "cache-key",
        // 落盘前的过期估算值，恢复后不应被直接信任
        resultEstimatedBytes: 999_999,
      },
    ];

    const restored = await store.setActiveResultRun(tabId, "run-1");

    expect(restored).toBe(true);
    expect(tab.result).toBeDefined();
    expect(tab.resultEstimatedBytes).toBeGreaterThan(0);
    expect(tab.resultEstimatedBytes).toBeLessThan(999_999);
  });

  it("clears grouped results and refreshes the estimate when the connection may be lost", async () => {
    // notifyConnectionMayBeLost 会初始化 connectionStore，其 setup 读取 localStorage
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => data.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => data.set(key, value)),
      removeItem: vi.fn((key: string) => data.delete(key)),
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const tabId = store.createTab("pg-1", "app", "grouped", "query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.results = [sampleResult(2000), sampleResult(2000)];
    tab.activeResultIndex = 0;
    tab.result = tab.results[0];
    tab.resultEstimatedBytes = 4_000_000;
    tab.isExecuting = true;

    store.notifyConnectionMayBeLost();

    // 分组结果必须清空：否则错误结果不会展示，估算也会继续按旧 results 计算
    expect(tab.results).toBeUndefined();
    expect(tab.result?.columns).toContain("Error");
    expect(tab.resultEstimatedBytes).toBeGreaterThan(0);
    expect(tab.resultEstimatedBytes).toBeLessThan(4_000_000);
  });

  it("invalidates run estimates when a full snapshot is restored from disk", async () => {
    const smallResult = sampleResult(2);
    vi.doMock("@/lib/tabs/tabResultCache", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/tabs/tabResultCache")>();
      return {
        ...actual,
        readTabResultSnapshot: vi.fn(
          async () =>
            ({
              result: smallResult,
              resultRuns: [
                {
                  id: "run-1",
                  title: "Run 1",
                  sequence: 1,
                  sql: "select 1",
                  createdAt: 1,
                  result: smallResult,
                  // 落盘前的过期估算值
                  resultEstimatedBytes: 888_888,
                },
              ],
              activeResultRunId: "run-1",
            }) as any,
        ),
      };
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const tabId = store.createTab("pg-1", "app", "evicted", "query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.resultEvicted = true;
    tab.resultCacheKey = "cache-key";

    await store.reloadEvictedTab(tabId);

    expect(tab.result).toBeDefined();
    expect(tab.resultRuns?.[0]?.resultEstimatedBytes).toBeUndefined();
    expect(tab.resultEstimatedBytes).toBeGreaterThan(0);
    expect(tab.resultEstimatedBytes).toBeLessThan(888_888);
  });

  it("invalidates estimates for every holder of a mutated payload", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const tabId = store.createTab("pg-1", "app", "edited", "query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    const payload = sampleResult(3);
    tab.result = payload;
    tab.resultEstimatedBytes = 111_111;
    tab.resultRuns = [
      { id: "run-1", title: "Run 1", sequence: 1, sql: "select 1", createdAt: 1, result: payload, resultEstimatedBytes: 222_222 },
      { id: "run-2", title: "Run 2", sequence: 2, sql: "select 2", createdAt: 2, result: sampleResult(3), resultEstimatedBytes: 333_333 },
    ];

    store.invalidateResultEstimateForPayload(tab.result);

    // 持有同一负载对象的 tab 与 run 估算都应失效，未持有的 run 不受影响
    expect(tab.resultEstimatedBytes).toBeUndefined();
    expect(tab.resultRuns[0]!.resultEstimatedBytes).toBeUndefined();
    expect(tab.resultRuns[1]!.resultEstimatedBytes).toBe(333_333);
  });

  it("keeps the estimate for the whole result group when switching result index", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const tabId = store.createTab("pg-1", "app", "multi", "query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.results = [sampleResult(5), sampleResult(10)];
    tab.activeResultIndex = 0;
    tab.result = tab.results[0];
    tab.resultEstimatedBytes = 555555;

    store.setActiveResultIndex(tabId, 1);

    // results 数组未变，组级估算值与激活下标无关
    expect(tab.activeResultIndex).toBe(1);
    expect(tab.resultEstimatedBytes).toBe(555555);
  });
});
