import { describe, expect, it } from "vitest";
import {
  averageTransposeRecordWidth,
  buildVisibleTransposeRows,
  calculateTransposeRecordWidth,
  defaultTransposeRecordWidth,
  minTransposeFieldWidth,
  shouldAutoTransposeSingleRow,
  transposeAnchorRowIndex,
  transposeFieldWidth,
  transposeScrollLeftForRecord,
  transposeRecordWidthsForDensity,
  visibleTransposeRecordWindow,
} from "@/lib/dataGrid/dataGridTranspose";

describe("single-row automatic transpose", () => {
  it("only opens for enabled multi-column results that are not preserving a manual transpose", () => {
    expect(shouldAutoTransposeSingleRow({ enabled: true, preserveTranspose: false, rowCount: 1, columnCount: 2 })).toBe(true);
    expect(shouldAutoTransposeSingleRow({ enabled: false, preserveTranspose: false, rowCount: 1, columnCount: 2 })).toBe(false);
    expect(shouldAutoTransposeSingleRow({ enabled: true, preserveTranspose: true, rowCount: 1, columnCount: 2 })).toBe(false);
    expect(shouldAutoTransposeSingleRow({ enabled: true, preserveTranspose: false, rowCount: 0, columnCount: 2 })).toBe(false);
    expect(shouldAutoTransposeSingleRow({ enabled: true, preserveTranspose: false, rowCount: 2, columnCount: 2 })).toBe(false);
    expect(shouldAutoTransposeSingleRow({ enabled: true, preserveTranspose: false, rowCount: 1, columnCount: 1 })).toBe(false);
  });
});

describe("transpose row anchor", () => {
  it("keeps the requested row when multiple rows or cells are selected", () => {
    const rowIds = [1, 2, 3, 4];

    expect(
      transposeAnchorRowIndex({
        requestedRowIndex: 3,
        rowIds,
        selectedRowIds: new Set([1, 4]),
        selectedRange: { startRow: 0, endRow: 3, startCol: 0, endCol: 1 },
      }),
    ).toBe(3);
  });
});

describe("dataGridTranspose density widths", () => {
  it("uses the shared density preset for record and field widths", () => {
    const values = ["x".repeat(40)];
    const columns = ["a_very_long_transpose_field_name"];

    const compactRecord = calculateTransposeRecordWidth(values, "compact");
    const standardRecord = calculateTransposeRecordWidth(values, "standard");
    const comfortableRecord = calculateTransposeRecordWidth(values, "comfortable");
    const compactField = transposeFieldWidth(columns, { density: "compact" });
    const standardField = transposeFieldWidth(columns, { density: "standard" });
    const comfortableField = transposeFieldWidth(columns, { density: "comfortable" });

    expect(compactRecord).toBeLessThan(standardRecord);
    expect(standardRecord).toBeLessThan(comfortableRecord);
    expect(compactField).toBeLessThan(standardField);
    expect(standardField).toBeLessThan(comfortableField);
    expect(transposeFieldWidth([], { density: "compact" })).toBe(minTransposeFieldWidth("compact"));
  });

  it("keeps compact record width independent of field order", () => {
    const longValue = "x".repeat(100);

    expect(calculateTransposeRecordWidth([longValue, "a"], "compact")).toBe(calculateTransposeRecordWidth(["a", longValue], "compact"));
  });

  it("recalculates automatic widths while preserving manual pixel overrides", () => {
    const records = [["x".repeat(40)], ["y".repeat(20)]];
    const standardWidths = transposeRecordWidthsForDensity({ records, density: "standard" });
    const comfortableWidths = transposeRecordWidthsForDensity({
      records,
      density: "comfortable",
      previousWidths: [333, standardWidths[1]],
      manualWidthIndexes: new Set([0]),
    });

    expect(comfortableWidths[0]).toBe(333);
    expect(comfortableWidths[1]).toBeGreaterThan(standardWidths[1]);
  });

  it("updates the virtual spacer estimate from recalculated density widths", () => {
    const records = Array.from({ length: 20 }, (_, index) => [`row-${index}-${"x".repeat(20)}`]);
    const compactWidths = transposeRecordWidthsForDensity({ records, density: "compact" });
    const comfortableWidths = transposeRecordWidthsForDensity({ records, density: "comfortable" });
    const compactWindow = visibleTransposeRecordWindow({
      totalRecords: records.length,
      scrollLeft: 500,
      viewportWidth: 400,
      pinnedWidth: transposeFieldWidth(["field"], { density: "compact" }),
      recordWidth: averageTransposeRecordWidth(compactWidths, "compact"),
      overscan: 0,
    });
    const comfortableWindow = visibleTransposeRecordWindow({
      totalRecords: records.length,
      scrollLeft: 500,
      viewportWidth: 400,
      pinnedWidth: transposeFieldWidth(["field"], { density: "comfortable" }),
      recordWidth: averageTransposeRecordWidth(comfortableWidths, "comfortable"),
      overscan: 0,
    });

    expect(averageTransposeRecordWidth(compactWidths, "compact")).toBeLessThan(averageTransposeRecordWidth(comfortableWidths, "comfortable"));
    expect(compactWindow.beforeWidth).not.toBe(comfortableWindow.beforeWidth);
    expect(compactWindow.afterWidth).not.toBe(comfortableWindow.afterWidth);
    expect(averageTransposeRecordWidth([], "compact")).toBe(defaultTransposeRecordWidth("compact"));
  });
});

describe("transpose record scrolling", () => {
  it("uses the scroll position after the sticky field for virtualization", () => {
    expect(
      visibleTransposeRecordWindow({
        totalRecords: 3,
        scrollLeft: 500,
        viewportWidth: 300,
        pinnedWidth: 100,
        recordWidth: 230,
        recordOffsets: [0, 500, 596, 692],
        overscan: 0,
      }),
    ).toEqual({ start: 1, end: 3, beforeWidth: 500, afterWidth: 0 });
  });

  it("uses actual record widths and nearest scrolling", () => {
    const recordOffsets = [0, 500, 596, 692];

    expect(
      transposeScrollLeftForRecord({
        recordIndex: 2,
        totalRecords: 3,
        viewportWidth: 300,
        pinnedWidth: 100,
        recordWidth: 230,
        recordOffsets,
        currentScrollLeft: 0,
      }),
    ).toBe(492);
    expect(
      transposeScrollLeftForRecord({
        recordIndex: 1,
        totalRecords: 3,
        viewportWidth: 300,
        pinnedWidth: 100,
        recordWidth: 230,
        recordOffsets,
        currentScrollLeft: 450,
      }),
    ).toBe(450);
  });
});

describe("dataGridTranspose field metadata", () => {
  it("keeps type and comment metadata aligned with visible columns", () => {
    const rows = buildVisibleTransposeRows({
      columns: ["display_name", "status"],
      records: [["Ada", 1]],
      recordIndexes: [0],
      valueIndexes: [0, 1],
      types: ["varchar", "int"],
      comments: ["User name", "Current status"],
      displayValue: String,
    });

    expect(rows.map(({ column, type, comment }) => ({ column, type, comment }))).toEqual([
      { column: "display_name", type: "varchar", comment: "User name" },
      { column: "status", type: "int", comment: "Current status" },
    ]);
  });
});
