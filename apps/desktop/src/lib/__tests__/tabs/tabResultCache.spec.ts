import { describe, expect, it, vi } from "vitest";
import { decodeTabResultSnapshot, encodeTabResultSnapshot, readResultCacheBackends, promoteFallbackResultCacheRead, resultCacheBackendOrder, resultCacheRuntimeConfig, selectResultCachePruneKeys, writeResultCacheBackends, type ResultCacheBackend } from "@/lib/tabs/tabResultCache";
import { queryResultLifecycleSnapshot } from "@/lib/__tests__/fixtures/queryResultLifecycle";

function backend(name: ResultCacheBackend["name"], overrides: Partial<ResultCacheBackend> = {}): ResultCacheBackend {
  return {
    name,
    available: () => true,
    read: async () => undefined,
    write: async () => true,
    delete: async () => undefined,
    listMetadata: async () => [],
    prune: async () => ({ deletedEntries: 0, deletedBytes: 0, orphanDeletions: 0, remainingEntries: 0, remainingBytes: 0 }),
    deleteOwner: async () => undefined,
    ...overrides,
  };
}

describe("tab result cache statement execution metadata", () => {
  it("selects one authoritative backend before fallback", () => {
    expect(resultCacheBackendOrder(true)).toEqual(["runtime", "indexed-db"]);
    expect(resultCacheBackendOrder(false)).toEqual(["indexed-db", "runtime"]);
  });

  it("uses explicit browser runtime configuration", () => {
    expect(resultCacheRuntimeConfig(false, { VITE_DBX_RESULT_CACHE_BACKEND: "http", VITE_DBX_RESULT_CACHE_FALLBACK: "true" } as ImportMetaEnv)).toEqual({
      primary: "runtime",
      fallbackEnabled: true,
    });
  });

  it("writes only to the first successful backend", async () => {
    const primaryWrite = vi.fn(async () => true);
    const fallbackWrite = vi.fn(async () => true);
    await writeResultCacheBackends([backend("runtime", { write: primaryWrite }), backend("indexed-db", { write: fallbackWrite })], "key", new Uint8Array([1]), { rowCount: 1, columnCount: 1 });
    expect(primaryWrite).toHaveBeenCalledOnce();
    expect(fallbackWrite).not.toHaveBeenCalled();
  });

  it("reads legacy fallback data for promotion", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const primary = backend("runtime");
    const fallback = backend("indexed-db", { read: async () => bytes });
    expect(await readResultCacheBackends([primary, fallback], "key")).toEqual({ bytes, backend: fallback });
  });

  it("promotes legacy IndexedDB or native bytes to the authoritative backend", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const primaryWrite = vi.fn(async () => true);
    const primary = backend("runtime", { write: primaryWrite });
    const legacy = backend("indexed-db");

    expect(await promoteFallbackResultCacheRead([primary, legacy], "key", { bytes, backend: legacy }, { rowCount: 2, columnCount: 1 }, "connection-1")).toBe(true);
    expect(primaryWrite).toHaveBeenCalledWith("key", bytes, { rowCount: 2, columnCount: 1 }, "connection-1");
  });

  it("skips an obsolete write before touching a backend", async () => {
    const write = vi.fn(async () => true);
    expect(await writeResultCacheBackends([backend("runtime", { write })], "key", new Uint8Array([1]), { rowCount: 1, columnCount: 1 }, () => false)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("prunes crash leftovers and then unreferenced LRU entries", () => {
    const selection = selectResultCachePruneKeys(
      [
        { key: "live", rowCount: 1, columnCount: 1, byteSize: 8, createdAt: 1, lastAccessedAt: 1 },
        { key: "crash", rowCount: 1, columnCount: 1, byteSize: 7, createdAt: 1, lastAccessedAt: 1 },
        { key: "recent", rowCount: 1, columnCount: 1, byteSize: 6, createdAt: 9_999, lastAccessedAt: 9_999 },
      ],
      { liveKeys: ["live"], maxBytes: 10, orphanGraceMs: 100, maxAgeMs: 1_000 },
      10_000,
    );
    expect(selection.keys).toEqual(["crash", "recent"]);
    expect(selection.result).toMatchObject({ orphanDeletions: 1, remainingBytes: 8 });
  });
  it("preserves statement identity and the editor fingerprint", () => {
    const encoded = encodeTabResultSnapshot({
      results: [
        {
          columns: ["value"],
          rows: [[1]],
          affected_rows: 0,
          execution_time_ms: 1,
          statement_index: 0,
          sourceStatement: "SELECT 1",
        },
        {
          columns: ["Error"],
          rows: [["failed"]],
          affected_rows: 0,
          execution_time_ms: 1,
          execution_error: true,
          statement_index: 1,
          sourceStatement: "SELECT bad",
        },
      ],
      resultEditorFingerprint: "15:0123456789abcdef",
      cachedAt: 1,
    });

    const restored = decodeTabResultSnapshot(encoded);

    expect(restored?.resultEditorFingerprint).toBe("15:0123456789abcdef");
    expect(restored?.results?.map((result) => ({ statementIndex: result.statement_index, error: result.execution_error }))).toEqual([
      { statementIndex: 0, error: undefined },
      { statementIndex: 1, error: true },
    ]);
  });

  it("preserves result-run statement execution state", () => {
    const encoded = encodeTabResultSnapshot({
      resultRuns: [
        {
          id: "run-1",
          title: "Run 1",
          sequence: 1,
          sql: "SELECT 1; SELECT bad",
          createdAt: 1,
          batchSqlExecution: {
            executionId: "exec-1",
            submittedSql: "SELECT 1; SELECT bad",
            editorFingerprint: "20:0123456789abcdef",
            sourceOffset: 0,
            completed: 2,
            total: 2,
            startedAt: 1,
            finishedAt: 2,
            items: [
              { statementIndex: 0, sql: "SELECT 1", from: 0, to: 8, status: "success", executionTimeMs: 1 },
              { statementIndex: 1, sql: "SELECT bad", from: 10, to: 20, status: "error", error: "failed", executionTimeMs: 1 },
            ],
          },
        },
      ],
      activeResultRunId: "run-1",
      cachedAt: 1,
    });

    expect(decodeTabResultSnapshot(encoded)?.resultRuns?.[0]?.batchSqlExecution).toMatchObject({
      executionId: "exec-1",
      completed: 2,
      total: 2,
      items: [{ status: "success" }, { status: "error", error: "failed" }],
    });
  });

  it("preserves spatial metadata", () => {
    const encoded = encodeTabResultSnapshot({
      result: {
        columns: ["geom"],
        column_types: ["geometry"],
        spatial_columns: [{ column_index: 0, srid: 4326 }],
        spatial_values: [[4326], [3857], [null]],
        rows: [["POINT(116.397 39.908)"], ["POINT(12957255 4852583)"], [null]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
      cachedAt: 1,
    });

    const result = decodeTabResultSnapshot(encoded).result;
    expect(result?.spatial_columns).toEqual([{ column_index: 0, srid: 4326 }]);
    expect(result?.spatial_values).toEqual([[4326], [3857], [null]]);
  });

  it("preserves large-value preview metadata", () => {
    const encoded = encodeTabResultSnapshot({
      result: {
        columns: ["id", "payload"],
        rows: [[1, "preview..."]],
        large_value_cells: [{ row_index: 0, column_index: 1, original_bytes: 1_000_000 }],
        affected_rows: 0,
        execution_time_ms: 1,
      },
      resultLocalSortOriginalRows: [[1, "preview..."]],
      resultLocalSortOriginalLargeValueCells: [{ row_index: 0, column_index: 1, original_bytes: 1_000_000 }],
      cachedAt: 1,
    });

    const restored = decodeTabResultSnapshot(encoded);
    expect(restored?.result?.large_value_cells).toEqual([{ row_index: 0, column_index: 1, original_bytes: 1_000_000 }]);
    expect(restored?.resultLocalSortOriginalLargeValueCells).toEqual([{ row_index: 0, column_index: 1, original_bytes: 1_000_000 }]);
  });

  it("restores multi-result, pagination, local-sort, and editable metadata fixtures", () => {
    const restored = decodeTabResultSnapshot(encodeTabResultSnapshot(queryResultLifecycleSnapshot()));

    expect(restored?.results).toHaveLength(2);
    expect(restored?.resultRuns?.[0]?.resultLocalSortOriginalRows).toEqual([[1, "Ada"]]);
    expect(restored?.resultPageOffset).toBe(200);
    expect(restored?.resultTotalRowCount).toBe(301);
    expect(restored?.tableMeta?.primaryKeys).toEqual(["id"]);
    expect(restored?.querySourceColumns).toEqual(["id", "name"]);
  });

  it("treats corrupt and unsupported snapshots as missing", () => {
    expect(decodeTabResultSnapshot(new Uint8Array([0xff, 0x00]))).toBeUndefined();
    const encoded = encodeTabResultSnapshot(queryResultLifecycleSnapshot());
    encoded[0] = 0xff;
    expect(decodeTabResultSnapshot(encoded)).toBeUndefined();
  });
});
