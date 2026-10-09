// @vitest-environment happy-dom

import { computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { buildDataGridColumnDistinctValuesSql } from "@/lib/dataGrid/dataGridSql";
import { DATA_GRID_DISTINCT_VALUE_DEFAULT_LIMIT, useDataGridDistinctValueLoader } from "@/composables/useDataGridDistinctValueLoader";
import type { QueryResult } from "@/types/database";

vi.mock("@/lib/backend/api", () => ({ executeQuery: vi.fn() }));
vi.mock("@/lib/dataGrid/dataGridSql", () => ({ buildDataGridColumnDistinctValuesSql: vi.fn(async () => "SELECT DISTINCT VALUES") }));

const disposers: Array<() => void> = [];

function mountLoader() {
  const identity = ref("table-1");
  const connectionId = ref<string | undefined>("connection-1");
  let loader: ReturnType<typeof useDataGridDistinctValueLoader> | undefined;
  const app = createApp(
    defineComponent({
      setup() {
        loader = useDataGridDistinctValueLoader({
          scopeIdentity: computed(() => identity.value),
          getConnectionId: () => connectionId.value,
          getExecutionDatabase: () => "app",
          getSchema: () => "public",
          getDatabaseType: () => "postgres",
          getConnectionConfig: () => ({
            driver_profile: "native",
            query_timeout_secs: 12,
            query_timeout_inherit: false,
          }),
          getIdentifierQuote: () => undefined,
          getGlobalQueryTimeoutSecs: () => 60,
          waitForTableMeta: async () => ({
            schema: "public",
            tableName: "users",
            columns: [{ name: "status", data_type: "varchar", is_nullable: true }],
          }),
          formatValue: (value) => String(value),
        });
        return () => h("div");
      },
    }),
  );
  app.mount(document.createElement("div"));
  disposers.push(() => app.unmount());
  if (!loader) throw new Error("loader was not mounted");
  return { loader, identity, connectionId };
}

function result(rows: QueryResult["rows"]): QueryResult {
  return { columns: ["dbx_value", "dbx_count"], rows };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useDataGridDistinctValueLoader", () => {
  it("keeps the default candidate limit at 1000", () => {
    expect(DATA_GRID_DISTINCT_VALUE_DEFAULT_LIMIT).toBe(1000);
  });

  it("marks results that reach the default 1000-candidate limit", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue(result(Array.from({ length: 1000 }, (_, index) => [`value-${index}`, 1])));
    const { loader } = mountLoader();

    await loader.load({ columnIndex: 0, columnName: "status" });

    expect(loader.options.value).toHaveLength(1000);
    expect(loader.limited.value).toBe(true);
  });

  it("uses the requested limit, keeps NULL, caches independent results, and resets on table changes", async () => {
    const rows: QueryResult["rows"] = Array.from({ length: 101 }, (_, index) => [`value-${index}`, 101 - index]);
    rows.splice(4, 0, [null, 9]);
    vi.mocked(api.executeQuery).mockResolvedValue(result(rows));
    const { loader, identity } = mountLoader();

    await loader.load({ columnIndex: 0, columnName: "status", limit: 100, includeCounts: true });

    expect(buildDataGridColumnDistinctValuesSql).toHaveBeenCalledWith(
      expect.objectContaining({
        columnName: "status",
        limit: 100,
        includeCounts: true,
        excludeNulls: false,
      }),
    );
    expect(vi.mocked(buildDataGridColumnDistinctValuesSql).mock.calls[0]?.[0]).not.toHaveProperty("whereInput");
    expect(api.executeQuery).toHaveBeenCalledWith(
      "connection-1",
      "app",
      "SELECT DISTINCT VALUES",
      "public",
      undefined,
      expect.objectContaining({
        maxRows: 100,
        fetchSize: 100,
        pageSize: 100,
        timeoutSecs: 12,
      }),
    );
    expect(loader.options.value).toHaveLength(100);
    expect(loader.options.value.some((option) => option.value === null)).toBe(true);
    expect(loader.limited.value).toBe(true);

    await loader.load({ columnIndex: 0, columnName: "status", limit: 100, includeCounts: true });
    expect(api.executeQuery).toHaveBeenCalledTimes(1);

    identity.value = "table-2";
    await nextTick();
    expect(loader.options.value).toEqual([]);
    await loader.load({ columnIndex: 0, columnName: "status", limit: 100, includeCounts: true });
    expect(api.executeQuery).toHaveBeenCalledTimes(2);
  });

  it("debounces searches and ignores a superseded response", async () => {
    let resolveFirst: ((value: QueryResult) => void) | undefined;
    vi.mocked(api.executeQuery)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(result([["new", 2]]));
    const { loader } = mountLoader();

    const first = loader.load({ columnIndex: 0, columnName: "status", searchValue: "old" });
    await vi.waitFor(() => expect(api.executeQuery).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    loader.schedule({ columnIndex: 0, columnName: "status", searchValue: "new" });
    await vi.advanceTimersByTimeAsync(299);
    expect(api.executeQuery).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.executeQuery).toHaveBeenCalledTimes(2);
    expect(loader.options.value.map((option) => option.value)).toEqual(["new"]);

    resolveFirst?.(result([["old", 9]]));
    await first;
    expect(loader.options.value.map((option) => option.value)).toEqual(["new"]);
  });

  it("clears the loading state when the connection disappears during a debounced search", async () => {
    vi.useFakeTimers();
    const { loader, connectionId } = mountLoader();
    connectionId.value = undefined;

    loader.schedule({ columnIndex: 0, columnName: "status", searchValue: "open" });
    expect(loader.loading.value).toBe(true);
    await vi.advanceTimersByTimeAsync(300);

    expect(loader.loading.value).toBe(false);
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("expires cached results after 30 seconds", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(api.executeQuery).mockResolvedValue(result([["open", 1]]));
    const { loader } = mountLoader();
    const request = { columnIndex: 0, columnName: "status", searchValue: "open" };

    await loader.load(request);
    now += 29_999;
    await loader.load(request);
    expect(api.executeQuery).toHaveBeenCalledTimes(1);

    now += 2;
    await loader.load(request);
    expect(api.executeQuery).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it("surfaces errors without retaining stale options and can recover", async () => {
    vi.mocked(api.executeQuery)
      .mockResolvedValueOnce(result([["ready", 1]]))
      .mockRejectedValueOnce(new Error("query failed"))
      .mockResolvedValueOnce(result([["recovered", 1]]));
    const { loader } = mountLoader();
    await loader.load({ columnIndex: 0, columnName: "status" });
    await loader.load({ columnIndex: 0, columnName: "status", searchValue: "missing" });
    expect(loader.options.value).toEqual([]);
    expect(loader.error.value).toBe("query failed");
    expect(loader.loading.value).toBe(false);
    await loader.load({ columnIndex: 0, columnName: "status", searchValue: "again" });
    expect(loader.error.value).toBe("");
    expect(loader.options.value.map((option) => option.value)).toEqual(["recovered"]);
  });
});
