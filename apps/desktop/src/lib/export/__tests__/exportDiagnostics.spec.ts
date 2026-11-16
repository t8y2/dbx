import { describe, expect, it } from "vitest";
import { summarizeExportRows } from "@/lib/export/exportDiagnostics";

describe("summarizeExportRows", () => {
  it("reports shape, value kinds, and large-cell sizes without retaining values", () => {
    const large = "中".repeat(1024 * 1024);
    const summary = summarizeExportRows([[null, "ok", 1, true], [large]]);

    expect(summary.rowCount).toBe(2);
    expect(summary.cellCount).toBe(5);
    expect(summary.nullCellCount).toBe(1);
    expect(summary.stringCellCount).toBe(2);
    expect(summary.numberCellCount).toBe(1);
    expect(summary.booleanCellCount).toBe(1);
    expect(summary.cellsAtLeast1MiB).toBe(1);
    expect(summary.rowsAtLeast1MiB).toBe(1);
    expect(summary.maxValueUtf8Bytes).toBe(3 * 1024 * 1024);
    expect(summary.minCellsPerRow).toBe(1);
    expect(summary.maxCellsPerRow).toBe(4);
  });

  it("handles empty and ragged results", () => {
    expect(summarizeExportRows([])).toMatchObject({ rowCount: 0, cellCount: 0, minCellsPerRow: 0, maxCellsPerRow: 0 });
    expect(summarizeExportRows([[], ["x"]])).toMatchObject({ rowCount: 2, cellCount: 1, minCellsPerRow: 0, maxCellsPerRow: 1 });
  });
});
