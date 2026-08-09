import { describe, expect, it } from "vitest";
import { appendLargeValueCells, largeValueCellMap, remapLargeValueCells } from "@/lib/dataGrid/dataGridLargeValues";
import { buildDataGridCellDetail } from "@/lib/dataGrid/dataGridDetail";

describe("data grid large-value metadata", () => {
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
