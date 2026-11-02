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

// The first test pays the cold transform of the store module, which can exceed
// the default 10s budget on Windows.
describe("queryStore resultViewGeneration", { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    setActivePinia(createPinia());
  });

  it("assigns a new generation when an error result replaces the dataset", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "error", "query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.result = sampleResult(2);
    tab.resultViewGeneration = "gen-old";

    store.setErrorResult(tabId, new Error("boom"));

    expect(tab.resultViewGeneration).toBeTruthy();
    expect(tab.resultViewGeneration).not.toBe("gen-old");
  });

  it("assigns a new generation for a local sort, because row order changes", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "local-sort", "query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.result = {
      ...sampleResult(3),
      rows: [
        [3, "c"],
        [1, "a"],
        [2, "b"],
      ],
    };
    tab.resultViewGeneration = "gen-old";

    store.sortTabResultLocally(tabId, "id", 0, "asc");

    expect(tab.result.rows.map((row) => row[0])).toEqual([1, 2, 3]);
    expect(tab.resultViewGeneration).toBeTruthy();
    expect(tab.resultViewGeneration).not.toBe("gen-old");
  });

  it("sorts bigint primary keys numerically using tableMeta type when result column_types is omitted (issue #13668)", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "users", "data");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.tableMeta = {
      tableName: "users",
      columns: [{ name: "id", data_type: "bigint(20)", is_primary_key: true } as any],
      primaryKeys: ["id"],
    };
    tab.result = {
      columns: ["id"],
      rows: [["92492"], ["9249"], ["100000"], ["92489"], ["1786326962000000000"]],
      affected_rows: 0,
      execution_time_ms: 1,
    };

    store.sortTabResultLocally(tabId, "id", 0, "desc");

    expect(tab.result.rows.map((row) => row[0])).toEqual(["1786326962000000000", "100000", "92492", "92489", "9249"]);
  });

  it("keeps original key locators and pending previews aligned through sorting and clearing the sort", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "original-keys", "query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.result = {
      ...sampleResult(2),
      rows: [
        [2, "same"],
        [1, "same"],
      ],
      raw_key_cells: [
        { row_index: 0, column_index: 1, value: "original B" },
        { row_index: 1, column_index: 1, value: "original A" },
      ],
      large_value_cells: [{ row_index: 0, column_index: 1, original_bytes: 20000, pending_decode: true }],
    };
    store.sortTabResultLocally(tabId, "id", 0, "asc");
    expect(tab.result.raw_key_cells).toEqual([
      { row_index: 1, column_index: 1, value: "original B" },
      { row_index: 0, column_index: 1, value: "original A" },
    ]);
    expect(tab.result.large_value_cells).toEqual([{ row_index: 1, column_index: 1, original_bytes: 20000, pending_decode: true }]);
    // Disk snapshots clone the original ordering separately. A later explicit
    // full read must survive clearing the sort without restoring pending state.
    tab.resultLocalSortOriginalRows = tab.resultLocalSortOriginalRows!.map((row) => [...row]);
    tab.result.rows[1]![1] = "resolved B";
    tab.result.large_value_cells = [];
    store.sortTabResultLocally(tabId, "id", 0, null);
    expect(tab.result.raw_key_cells).toEqual([
      { row_index: 0, column_index: 1, value: "original B" },
      { row_index: 1, column_index: 1, value: "original A" },
    ]);
    expect(tab.result.large_value_cells).toBeUndefined();
    expect(tab.result.rows[0]![1]).toBe("resolved B");
    expect(tab.resultLocalSortOriginalRawKeyCells).toBeUndefined();
  });

  it("inherits the generation when a result is restored from disk", async () => {
    const cached = sampleResult(2);
    vi.doMock("@/lib/tabs/tabResultCache", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/tabs/tabResultCache")>();
      return {
        ...actual,
        readTabResultSnapshot: vi.fn(async () => ({ result: cached, resultViewGeneration: "gen-disk" }) as any),
      };
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "evicted", "query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.resultEvicted = true;
    tab.resultCacheKey = "tab:cache:key";
    tab.resultViewGeneration = "gen-disk";

    await store.reloadEvictedTab(tabId);

    expect(tab.result).toBeDefined();
    expect(tab.resultViewGeneration).toBe("gen-disk");
    vi.doUnmock("@/lib/tabs/tabResultCache");
  });

  it("projects the run's generation onto the tab when switching result runs", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "runs", "query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    const first = { id: "run-1", title: "Run 1", sequence: 1, sql: "select 1", createdAt: 1, result: sampleResult(1), resultGridRevision: "rev-1", resultViewGeneration: "gen-run-1" };
    const second = { id: "run-2", title: "Run 2", sequence: 2, sql: "select 2", createdAt: 2, result: sampleResult(1), resultGridRevision: "rev-2", resultViewGeneration: "gen-run-2" };
    tab.resultRuns = [first, second];
    tab.activeResultRunId = "run-1";
    tab.resultViewGeneration = "gen-run-1";

    await store.setActiveResultRun(tabId, "run-2", { evictInactive: false });

    expect(tab.resultViewGeneration).toBe("gen-run-2");
  });

  it("does not let a legacy run without a generation inherit the tab's value", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "legacy-run", "query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    const legacy = { id: "run-legacy", title: "Legacy", sequence: 1, sql: "select 1", createdAt: 1, result: sampleResult(1) };
    tab.resultRuns = [legacy];
    tab.activeResultRunId = "run-legacy";
    tab.resultViewGeneration = "gen-stale";

    await store.setActiveResultRun(tabId, "run-legacy", { evictInactive: false });

    expect(tab.resultViewGeneration).toBeTruthy();
    expect(tab.resultViewGeneration).not.toBe("gen-stale");
  });
});
