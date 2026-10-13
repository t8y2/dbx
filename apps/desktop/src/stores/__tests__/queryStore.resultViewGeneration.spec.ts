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

  it("preserves row metadata and original order through multi-column sorting and clearing", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "multi-sort", "query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    const rows: QueryResult["rows"] = [
      ["b", "10", "preview-b"],
      ["a", "2", "preview-a2"],
      ["a", "10", "preview-a10"],
    ];
    tab.result = {
      ...sampleResult(0),
      columns: ["name", "score", "content"],
      column_types: ["varchar", "bigint", "text"],
      rows,
      large_value_cells: [{ row_index: 0, column_index: 2, original_bytes: 1000000 }],
      mongo_documents: rows.map((_, index) => ({ source: index })),
      mongo_copy_documents: rows.map((_, index) => JSON.stringify({ source: index })),
    };
    const columns = [
      { column: "name", columnIndex: 0, direction: "asc" as const },
      { column: "score", columnIndex: 1, direction: "desc" as const },
    ];
    store.sortTabResultLocally(tabId, "score", 1, "desc", columns);
    expect(tab.result.rows).toEqual([rows[2], rows[1], rows[0]]);
    expect(tab.result.mongo_documents).toEqual([{ source: 2 }, { source: 1 }, { source: 0 }]);
    expect(tab.result.mongo_copy_documents).toEqual(['{"source":2}', '{"source":1}', '{"source":0}']);
    expect(tab.result.large_value_cells?.[0]?.row_index).toBe(2);
    expect(tab.resultSortColumns).toEqual(columns);
    expect(tab.resultSortColumn).toBe("name");
    store.sortTabResultLocally(tabId, "score", 1, null, [columns[0]!]);
    expect(tab.result.rows).toEqual([rows[1], rows[2], rows[0]]);
    store.sortTabResultLocally(tabId, "name", 0, null, []);
    expect(tab.result.rows).toEqual(rows);
    expect(tab.result.large_value_cells?.[0]?.row_index).toBe(0);
    expect(tab.resultSortColumns).toBeUndefined();
    expect(tab.resultLocalSortOriginalRows).toBeUndefined();
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
