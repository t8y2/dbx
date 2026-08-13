import { describe, expect, it } from "vitest";
import { appendLargeValueCells, canUseTableDataLargeValuePreview, largeValueCellMap, remapLargeValueCells, TABLE_DATA_CELL_PREVIEW_SIZE, TABLE_DATA_PREVIEW_CONTENT_MAX_BYTES, tableDataLargeValuePreviewOptions } from "@/lib/dataGrid/dataGridLargeValues";
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
