import { describe, expect, it, vi } from "vitest";
import {
  appendLargeValueCells,
  canUseTableDataLargeValuePreview,
  createResultScopedPendingRequests,
  createResultScopedRowCache,
  isTableDataVisiblePreviewColumn,
  largeValueCellMap,
  remapLargeValueCells,
  TABLE_DATA_CELL_PREVIEW_SIZE,
  TABLE_DATA_PREVIEW_CONTENT_MAX_BYTES,
  tableDataLargeValuePreviewOptions,
  tableDataVisiblePreviewContentBytes,
  tableDataVisiblePreviewRowRange,
} from "@/lib/dataGrid/dataGridLargeValues";
import { buildDataGridCellDetail } from "@/lib/dataGrid/dataGridDetail";
import type { ColumnInfo } from "@/types/database";

function column(name: string, dataType: string, isPrimaryKey = false): ColumnInfo {
  return {
    name,
    data_type: dataType,
    is_nullable: false,
    column_default: null,
    is_primary_key: isPrimaryKey,
    extra: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("data grid large-value metadata", () => {
  it("enables bounded table previews only for supported databases with stable keys", () => {
    const columns = [column("id", "bigint", true), column("payload", "longtext")];

    expect(tableDataLargeValuePreviewOptions("mysql", columns, ["id"], 100)).toEqual({
      columnTypes: ["bigint", "longtext"],
      largeValuePreviewSize: TABLE_DATA_CELL_PREVIEW_SIZE,
    });
    expect(tableDataLargeValuePreviewOptions("postgres", columns, ["id"], 100)).toEqual({
      columnTypes: ["bigint", "longtext"],
      largeValuePreviewSize: TABLE_DATA_CELL_PREVIEW_SIZE,
    });
    expect(tableDataLargeValuePreviewOptions("sqlite", columns, ["id"], 100)).toEqual({});
    expect(tableDataLargeValuePreviewOptions("mysql", columns, [], 100)).toEqual({});
    expect(tableDataLargeValuePreviewOptions("mysql", [columns[0]!], ["id"], 100)).toEqual({});
  });

  it("disables marker parsing when a real column uses the reserved preview prefix", () => {
    const columns = [column("id", "bigint", true), column("__dbx_large_value_bytes_t_0", "text")];

    expect(canUseTableDataLargeValuePreview("postgres", columns, ["id"])).toBe(false);
    expect(tableDataLargeValuePreviewOptions("postgres", columns, ["id"], 100)).toEqual({});
  });

  it("shrinks each cell preview by serialized byte budget without changing page size", () => {
    const columns = [column("id", "bigint", true), ...Array.from({ length: 256 }, (_, index) => column(`payload_${index}`, "text"))];
    const options = tableDataLargeValuePreviewOptions("postgres", columns, ["ID"], 1_000);

    expect(options).toEqual({
      columnTypes: columns.map((item) => item.data_type),
      largeValuePreviewSize: 16,
    });

    if (!("largeValuePreviewSize" in options)) throw new Error("expected preview options");
    const previewSize = options.largeValuePreviewSize;
    const previewCellCount = 1_000 * 256;
    const serializedSamples = ["中".repeat(previewSize), "😀".repeat(previewSize), "\u0000".repeat(previewSize)];
    for (const sample of serializedSamples) {
      const serializedContent = JSON.stringify(sample).slice(1, -1);
      const serializedBytes = new TextEncoder().encode(serializedContent).byteLength * previewCellCount;
      expect(serializedBytes).toBeLessThanOrEqual(TABLE_DATA_PREVIEW_CONTENT_MAX_BYTES);
    }
  });

  it("selects the visible rows plus a bounded viewport buffer", () => {
    expect(tableDataVisiblePreviewRowRange(26 * 50, 26 * 20, 26, 10_000)).toEqual({ start: 30, end: 90 });
    expect(tableDataVisiblePreviewRowRange(0, 26 * 20, 26, 10_000)).toEqual({ start: 0, end: 60 });
    expect(tableDataVisiblePreviewRowRange(26 * 9_990, 26 * 20, 26, 10_000)).toEqual({ start: 9_940, end: 10_000 });
    expect(tableDataVisiblePreviewRowRange(0, 0, 26, 0)).toBeNull();
  });

  it("hydrates only textual large-value types in the visible area", () => {
    expect(isTableDataVisiblePreviewColumn("mysql", "longtext")).toBe(true);
    expect(isTableDataVisiblePreviewColumn("mysql", "varchar(8000)")).toBe(true);
    expect(isTableDataVisiblePreviewColumn("mysql", "longblob")).toBe(false);
    expect(isTableDataVisiblePreviewColumn("postgres", "character varying(8000)")).toBe(true);
    expect(isTableDataVisiblePreviewColumn("postgres", "jsonb")).toBe(true);
    expect(isTableDataVisiblePreviewColumn("postgres", "text[]")).toBe(false);
    expect(isTableDataVisiblePreviewColumn("postgres", "vector(1536)")).toBe(false);
    expect(isTableDataVisiblePreviewColumn("oracle", "clob")).toBe(false);
  });

  it("evicts old preview rows while retaining the active viewport", () => {
    const cache = createResultScopedRowCache<string>(2);
    cache.remember(1, 2, "one");
    cache.remember(2, 2, "two");
    cache.remember(3, 2, "three");

    expect(cache.get(1, 2)).toBe("one");
    expect(cache.evict(new Set([1]))).toEqual([{ rowIndex: 2, columnIndex: 2, value: "two" }]);
    expect(cache.has(1, 2)).toBe(true);
    expect(cache.has(2, 2)).toBe(false);
    expect(cache.has(3, 2)).toBe(true);

    cache.forget(1, 2);
    expect(cache.has(1, 2)).toBe(false);
  });

  it("bounds cached preview content while preserving the newest active rows", () => {
    const cache = createResultScopedRowCache<string>(10, { maxBytes: 6, sizeOf: (value) => value.length });
    cache.remember(1, 1, "one");
    cache.remember(2, 1, "two");
    cache.remember(3, 1, "four");

    expect(cache.evict(new Set([3]))).toEqual([
      { rowIndex: 1, columnIndex: 1, value: "one" },
      { rowIndex: 2, columnIndex: 1, value: "two" },
    ]);
    expect(cache.has(3, 1)).toBe(true);

    const oversizedActive = createResultScopedRowCache<string>(10, { maxBytes: 3, sizeOf: (value) => value.length });
    oversizedActive.remember(1, 1, "four");
    expect(oversizedActive.evict(new Set([1]))).toEqual([{ rowIndex: 1, columnIndex: 1, value: "four" }]);
    expect(oversizedActive.has(1, 1)).toBe(false);
    expect(tableDataVisiblePreviewContentBytes("🙂")).toBe(4);
  });

  it("uses the active MySQL page budget to select bounded preview columns", () => {
    const columns = [column("id", "int", true), column("image_mime", "varchar(64)"), column("image_data", "longblob"), column("image_url", "varchar(512)"), column("image_note", "varchar(255)")];

    expect(tableDataLargeValuePreviewOptions("mysql", columns, ["id"], 10_000)).toEqual({
      columnTypes: columns.map((item) => item.data_type),
      largeValuePreviewSize: 139,
    });
    expect(tableDataLargeValuePreviewOptions("mysql", columns, ["id"], 100)).toEqual({
      columnTypes: columns.map((item) => item.data_type),
      largeValuePreviewSize: TABLE_DATA_CELL_PREVIEW_SIZE,
    });
    expect(
      tableDataLargeValuePreviewOptions(
        "mysql",
        columns.filter((item) => item.name !== "image_data"),
        ["id"],
        100,
      ),
    ).toEqual({});
    expect(tableDataLargeValuePreviewOptions("mysql", [column("id", "int", true), column("payload", "varchar(8000)")], ["id"], 10_000)).toEqual({
      columnTypes: ["int", "varchar(8000)"],
      largeValuePreviewSize: 419,
    });
  });

  it("offsets appended segment rows and discards metadata beyond the append cap", () => {
    expect(
      appendLargeValueCells(
        [{ row_index: 0, column_index: 1, original_bytes: 10_000 }],
        [
          { row_index: 0, column_index: 1, original_bytes: 20_000 },
          { row_index: 1, column_index: 2, original_bytes: 30_000 },
          { row_index: 2, column_index: 1, original_bytes: 40_000 },
        ],
        2,
        2,
      ),
    ).toEqual([
      { row_index: 0, column_index: 1, original_bytes: 10_000 },
      { row_index: 2, column_index: 1, original_bytes: 20_000 },
      { row_index: 3, column_index: 2, original_bytes: 30_000 },
    ]);
  });

  it("remaps metadata to locally sorted row positions", () => {
    expect(
      remapLargeValueCells(
        [
          { row_index: 0, column_index: 1, original_bytes: 10_000 },
          { row_index: 2, column_index: 1, original_bytes: 30_000 },
        ],
        [2, 0, 1],
      ),
    ).toEqual([
      { row_index: 1, column_index: 1, original_bytes: 10_000 },
      { row_index: 0, column_index: 1, original_bytes: 30_000 },
    ]);
  });

  it("indexes metadata by source row and column", () => {
    const result = { large_value_cells: [{ row_index: 4, column_index: 2, original_bytes: 65_536 }] };
    expect(largeValueCellMap(result).get("4:2")).toEqual(result.large_value_cells[0]);
  });

  it("deduplicates pending requests only within the same result", async () => {
    const requests = createResultScopedPendingRequests<boolean>();
    const result = {};
    const load = deferred<boolean>();
    const request = vi.fn(() => load.promise);

    const first = requests.run("0:1", result, request);
    const second = requests.run("0:1", result, request);
    await Promise.resolve();

    expect(second).toBe(first);
    expect(request).toHaveBeenCalledOnce();

    load.resolve(true);
    await expect(first).resolves.toBe(true);
  });

  it("keeps the newer result request after the previous result settles", async () => {
    const requests = createResultScopedPendingRequests<boolean>();
    const previousLoad = deferred<boolean>();
    const currentLoad = deferred<boolean>();
    const previousResult = {};
    const currentResult = {};
    const currentRequest = vi.fn(() => currentLoad.promise);

    const previous = requests.run("0:1", previousResult, () => previousLoad.promise);
    const current = requests.run("0:1", currentResult, currentRequest);
    await Promise.resolve();

    previousLoad.resolve(false);
    await expect(previous).resolves.toBe(false);

    const deduplicatedCurrent = requests.run("0:1", currentResult, currentRequest);
    expect(deduplicatedCurrent).toBe(current);
    expect(currentRequest).toHaveBeenCalledOnce();

    currentLoad.resolve(true);
    await expect(current).resolves.toBe(true);
  });

  it("marks a backend-bounded value as truncated even when the preview is shorter than the UI limit", () => {
    const detail = buildDataGridCellDetail({
      rowIndex: 0,
      rowId: 1,
      row: ["preview..."],
      columns: ["payload"],
      columnIndex: 0,
      displayValue: String,
      isEditable: true,
      isValuePreviewTruncated: true,
    });

    expect(detail?.isValuePreviewTruncated).toBe(true);
  });
});
