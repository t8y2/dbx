import { describe, expect, it } from "vitest";
import { snapshotExportSelection, assertSnapshotXlsxCellLengths } from "@/lib/dataGrid/snapshotExport";
import type { QueryResult } from "@/types/database";

const result = {
  columns: ["ID", "Value", "value"],
  rows: [
    [1, "first preview", "second preview"],
    [2, "third preview", null],
  ],
  large_value_context: { connectionId: "original", database: "oracletest", clientSessionId: "original-session" },
  large_value_cells: [
    { row_index: 0, column_index: 1, value_ref: "first", value_kind: "text" },
    { row_index: 0, column_index: 2, value_ref: "second", value_kind: "text" },
    { row_index: 1, column_index: 1, value_ref: "third", value_kind: "text" },
  ],
} as QueryResult;

describe("snapshot export selection", () => {
  it("refuses XLSX truncation while retaining the complete value for other formats", () => {
    expect(() => assertSnapshotXlsxCellLengths([["a".repeat(32767)]])).not.toThrow();
    const value = "中🙂".repeat(20000);
    expect(() => assertSnapshotXlsxCellLengths([[value]])).toThrow("XLSX cannot preserve");
    expect(Array.from(value)).toHaveLength(40000);
  });
  it("remaps sorted rows and projected quoted columns by source positions", () => {
    const selected = snapshotExportSelection(
      result,
      ["value", "Value"],
      [2, 1],
      [
        { sourceIndex: 1, data: [null, "third preview"] },
        { sourceIndex: 0, data: ["second preview", "first preview"] },
      ],
    )!;
    expect(selected.cells).toEqual([
      { rowIndex: 0, columnIndex: 1, valueRef: "third" },
      { rowIndex: 1, columnIndex: 0, valueRef: "second" },
      { rowIndex: 1, columnIndex: 1, valueRef: "first" },
    ]);
    expect(selected.context).toEqual({ ...result.large_value_context, valueRef: "" });
  });
  it("preserves complete dirty values and new rows rather than substituting their original snapshots", () => {
    const selected = snapshotExportSelection(
      result,
      ["Value", "value"],
      [1, 2],
      [
        { sourceIndex: 0, data: ["edited complete", "second preview"], isDirtyCol: [true, false] },
        { isNew: true, data: ["new complete", "other complete"] },
      ],
    )!;
    expect(selected.cells).toEqual([{ rowIndex: 0, columnIndex: 1, valueRef: "second" }]);
    expect(selected.rows[0]![0]).toBe("edited complete");
    expect(result.rows[0]![1]).toBe("first preview");
  });
  it("fails before export when original connection context is missing", () => {
    expect(() => snapshotExportSelection({ ...result, large_value_context: undefined }, ["Value"], [1], [{ sourceIndex: 0, data: ["preview"] }])).toThrow("connection is unavailable");
    expect(snapshotExportSelection(result, ["ID"], [0], [{ sourceIndex: 0, data: [1] }])).toBeUndefined();
  });
});
