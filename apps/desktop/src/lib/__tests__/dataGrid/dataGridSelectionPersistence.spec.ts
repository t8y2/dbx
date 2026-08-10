import { describe, expect, it } from "vitest";
import { captureDataGridSelection, restoreDataGridSelection, type CaptureDataGridSelectionOptions } from "@/lib/dataGrid/dataGridSelectionPersistence";

function baseOptions(overrides: Partial<CaptureDataGridSelectionOptions> = {}): CaptureDataGridSelectionOptions {
  return {
    columns: ["id", "tenant_id", "name"],
    rows: [
      [1, 10, "Ada"],
      [2, 10, "Grace"],
      [3, 20, "Linus"],
    ],
    primaryKeys: ["id"],
    visibleColumnIndexes: [0, 1, 2],
    displayItems: [
      { id: 0, sourceIndex: 0 },
      { id: 1, sourceIndex: 1 },
      { id: 2, sourceIndex: 2 },
    ],
    selectedRowIds: new Set(),
    selectedColumnIndexes: new Set(),
    selectedCellKeys: new Set(),
    selectionAnchor: null,
    selectionFocus: null,
    selectingAll: false,
    ...overrides,
  };
}

function restore(snapshot: NonNullable<ReturnType<typeof captureDataGridSelection>>, overrides: Partial<Parameters<typeof restoreDataGridSelection>[0]> = {}) {
  return restoreDataGridSelection({
    snapshot,
    columns: ["id", "tenant_id", "name"],
    rows: [
      [1, 10, "Ada"],
      [2, 10, "Grace"],
      [3, 20, "Linus"],
    ],
    visibleColumnIndexes: [0, 1, 2],
    displayItems: [
      { id: 0, sourceIndex: 0 },
      { id: 1, sourceIndex: 1 },
      { id: 2, sourceIndex: 2 },
    ],
    ...overrides,
  });
}

describe("data grid selection persistence", () => {
  it("restores a selected cell by primary key after rows move", () => {
    const snapshot = captureDataGridSelection(baseOptions({ selectionAnchor: { rowIndex: 1, colIndex: 2 }, selectionFocus: { rowIndex: 1, colIndex: 2 } }))!;

    expect(
      restore(snapshot, {
        rows: [
          [2, 10, "Grace updated"],
          [1, 10, "Ada"],
          [3, 20, "Linus"],
        ],
      }),
    ).toEqual({ kind: "range", anchor: { rowIndex: 0, colIndex: 2 }, focus: { rowIndex: 0, colIndex: 2 }, selectingAll: false, scrollRowIndex: 0 });
  });

  it("supports composite keys and source-column aliases", () => {
    const snapshot = captureDataGridSelection(
      baseOptions({
        columns: ["tenant", "record", "display_name"],
        sourceColumns: ["tenant_id", "id", "name"],
        rows: [
          [10, 1, "Ada"],
          [10, 2, "Grace"],
          [20, 3, "Linus"],
        ],
        primaryKeys: ["tenant_id", "id"],
        selectionAnchor: { rowIndex: 2, colIndex: 2 },
        selectionFocus: { rowIndex: 2, colIndex: 2 },
      }),
    )!;

    expect(
      restoreDataGridSelection({
        snapshot,
        columns: ["tenant", "record", "display_name"],
        sourceColumns: ["tenant_id", "id", "name"],
        rows: [
          [20, 3, "Linus updated"],
          [10, 1, "Ada"],
          [10, 2, "Grace"],
        ],
        visibleColumnIndexes: [0, 1, 2],
        displayItems: [
          { id: 0, sourceIndex: 0 },
          { id: 1, sourceIndex: 1 },
          { id: 2, sourceIndex: 2 },
        ],
      }),
    ).toMatchObject({ kind: "range", anchor: { rowIndex: 0, colIndex: 2 } });
  });

  it("does not mistake an unrelated source column alias for a primary key", () => {
    const snapshot = captureDataGridSelection(
      baseOptions({
        columns: ["id", "name"],
        sourceColumns: ["external_id", "name"],
        rows: [
          [101, "Ada"],
          [102, "Grace"],
        ],
        primaryKeys: ["id"],
        visibleColumnIndexes: [0, 1],
        displayItems: [
          { id: 0, sourceIndex: 0 },
          { id: 1, sourceIndex: 1 },
        ],
        selectionAnchor: { rowIndex: 1, colIndex: 1 },
        selectionFocus: { rowIndex: 1, colIndex: 1 },
      }),
    )!;

    expect(snapshot.identity.mode).toBe("row");
  });

  it("restores row selection and preserves its Shift-selection anchor", () => {
    const snapshot = captureDataGridSelection(baseOptions({ selectedRowIds: new Set([0, 2]), lastClickedRowIndex: 2 }))!;

    expect(
      restore(snapshot, {
        rows: [
          [3, 20, "Linus"],
          [2, 10, "Grace"],
          [1, 10, "Ada"],
        ],
      }),
    ).toEqual({ kind: "rows", rowIds: [2, 0], anchorRowIndex: 0, scrollRowIndex: 2 });
  });

  it("restores sparse cells and visible column selections", () => {
    const cellSnapshot = captureDataGridSelection(baseOptions({ selectedCellKeys: new Set(["0:0", "2:2"]) }))!;
    const columnSnapshot = captureDataGridSelection(baseOptions({ selectedColumnIndexes: new Set([0, 2]) }))!;

    expect(restore(cellSnapshot)).toEqual({ kind: "cells", cellKeys: new Set(["0:0", "2:2"]), scrollRowIndex: 2 });
    expect(restore(columnSnapshot, { visibleColumnIndexes: [2, 0] })).toEqual({ kind: "columns", columnIndexes: [1, 0] });
  });

  it("keeps select-all semantics when the refreshed result gains rows", () => {
    const snapshot = captureDataGridSelection(baseOptions({ selectionAnchor: { rowIndex: 0, colIndex: 0 }, selectionFocus: { rowIndex: 2, colIndex: 2 }, selectingAll: true }))!;

    expect(
      restore(snapshot, {
        rows: [
          [1, 10, "Ada"],
          [2, 10, "Grace"],
          [3, 20, "Linus"],
          [4, 30, "Margaret"],
        ],
        displayItems: [
          { id: 0, sourceIndex: 0 },
          { id: 1, sourceIndex: 1 },
          { id: 2, sourceIndex: 2 },
          { id: 3, sourceIndex: 3 },
        ],
      }),
    ).toEqual({ kind: "range", anchor: { rowIndex: 0, colIndex: 0 }, focus: { rowIndex: 3, colIndex: 2 }, selectingAll: true, scrollRowIndex: 0 });
  });

  it("uses the hidden row identifier when it is the declared key", () => {
    const snapshot = captureDataGridSelection(
      baseOptions({
        columns: ["name", "__DBX_ROWID"],
        rows: [
          ["Ada", "AAA1"],
          ["Grace", "AAA2"],
        ],
        primaryKeys: ["__DBX_ROWID"],
        visibleColumnIndexes: [0],
        displayItems: [
          { id: 0, sourceIndex: 0 },
          { id: 1, sourceIndex: 1 },
        ],
        selectionAnchor: { rowIndex: 1, colIndex: 0 },
        selectionFocus: { rowIndex: 1, colIndex: 0 },
      }),
    )!;

    expect(
      restoreDataGridSelection({
        snapshot,
        columns: ["name", "__DBX_ROWID"],
        rows: [
          ["Grace changed", "AAA2"],
          ["Ada", "AAA1"],
        ],
        visibleColumnIndexes: [0],
        displayItems: [
          { id: 0, sourceIndex: 0 },
          { id: 1, sourceIndex: 1 },
        ],
      }),
    ).toMatchObject({ kind: "range", anchor: { rowIndex: 0, colIndex: 0 } });
  });

  it("falls back to type-safe full-row matching and distinguishes duplicate occurrences", () => {
    const snapshot = captureDataGridSelection(
      baseOptions({
        columns: ["value"],
        rows: [[1], ["1"], ["same"], ["same"]],
        primaryKeys: [],
        visibleColumnIndexes: [0],
        displayItems: [
          { id: 0, sourceIndex: 0 },
          { id: 1, sourceIndex: 1 },
          { id: 2, sourceIndex: 2 },
          { id: 3, sourceIndex: 3 },
        ],
        selectionAnchor: { rowIndex: 3, colIndex: 0 },
        selectionFocus: { rowIndex: 3, colIndex: 0 },
      }),
    )!;

    expect(
      restoreDataGridSelection({
        snapshot,
        columns: ["value"],
        rows: [["same"], [1], ["same"], ["1"]],
        visibleColumnIndexes: [0],
        displayItems: [
          { id: 0, sourceIndex: 0 },
          { id: 1, sourceIndex: 1 },
          { id: 2, sourceIndex: 2 },
          { id: 3, sourceIndex: 3 },
        ],
      }),
    ).toMatchObject({ kind: "range", anchor: { rowIndex: 2, colIndex: 0 } });
  });

  it("clears safely when the row disappears, is filtered out, or the fallback row shape changes", () => {
    const keyedSnapshot = captureDataGridSelection(baseOptions({ selectionAnchor: { rowIndex: 1, colIndex: 1 }, selectionFocus: { rowIndex: 1, colIndex: 1 } }))!;
    const fallbackSnapshot = captureDataGridSelection(baseOptions({ primaryKeys: [], selectionAnchor: { rowIndex: 1, colIndex: 1 }, selectionFocus: { rowIndex: 1, colIndex: 1 } }))!;

    expect(restore(keyedSnapshot, { rows: [[1, 10, "Ada"]], displayItems: [{ id: 0, sourceIndex: 0 }] })).toBeNull();
    expect(
      restore(keyedSnapshot, {
        displayItems: [
          { id: 0, sourceIndex: 0 },
          { id: 2, sourceIndex: 2 },
        ],
      }),
    ).toBeNull();
    expect(
      restore(fallbackSnapshot, {
        rows: [
          [1, 10, "Ada"],
          [2, 10, "Grace changed"],
          [3, 20, "Linus"],
        ],
      }),
    ).toBeNull();
    expect(restore(fallbackSnapshot, { columns: ["id", "name"], rows: [[2, "Grace"]], visibleColumnIndexes: [0, 1], displayItems: [{ id: 0, sourceIndex: 0 }] })).toBeNull();
  });
});
