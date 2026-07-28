import { describe, expect, it } from "vitest";
import { averageTransposeRecordWidth, calculateTransposeRecordWidth, defaultTransposeRecordWidth, minTransposeFieldWidth, shouldAutoTransposeSingleRow, transposeFieldWidth, transposeRecordWidthsForDensity, visibleTransposeRecordWindow } from "@/lib/dataGrid/dataGridTranspose";

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
