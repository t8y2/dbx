import { describe, expect, it } from "vitest";
import { createPendingSelectionSummary, dedupeColumnIndexes, formatSelectionAggregate, formatSelectionAverage, summarizeSelection } from "@/lib/dataGrid/gridSelection";

describe("gridSelection", () => {
  it("summarizes empty selections", () => {
    expect(summarizeSelection({ columns: [], rows: [] })).toEqual({
      cellCount: 0,
      rowCount: 0,
      numericCount: 0,
      sum: 0,
      average: null,
    });
  });

  it("summarizes numeric selections", () => {
    expect(
      summarizeSelection({
        columns: ["a", "b"],
        rows: [
          [1, 2],
          [3, 4],
        ],
      }),
    ).toEqual({
      cellCount: 4,
      rowCount: 2,
      numericCount: 4,
      sum: 10,
      average: 2.5,
    });
  });

  it("summarizes numeric strings and ignores non-numeric values", () => {
    expect(
      summarizeSelection({
        columns: ["id", "value", "flag"],
        rows: [
          ["100", 2.5, true],
          [null, "not a number", 3],
        ],
      }),
    ).toEqual({
      cellCount: 6,
      rowCount: 2,
      numericCount: 3,
      sum: 105.5,
      average: 105.5 / 3,
    });
  });

  it("uses the same numeric participation rules for sum and average", () => {
    expect(
      summarizeSelection({
        columns: ["value"],
        rows: [[null], [true], [false], [""], ["   "], ["not a number"], [Number.NaN], [Number.POSITIVE_INFINITY]],
      }),
    ).toEqual({
      cellCount: 8,
      rowCount: 8,
      numericCount: 0,
      sum: 0,
      average: null,
    });
  });

  it.each([
    ["single cell", [[8]], 1, 1, 8],
    ["row", [[1, 3]], 2, 1, 2],
    ["column", [[1], [3]], 2, 2, 2],
    [
      "range",
      [
        [1, 2],
        [3, 4],
      ],
      4,
      2,
      2.5,
    ],
  ] as const)("averages a %s selection without changing its counts", (_label, rows, cellCount, rowCount, average) => {
    expect(summarizeSelection({ columns: [], rows: rows.map((row) => [...row]) })).toMatchObject({ cellCount, rowCount, average });
  });

  it("does not expose an infinite average when a finite-value sum overflows", () => {
    expect(summarizeSelection({ columns: ["value"], rows: [[Number.MAX_VALUE], [Number.MAX_VALUE]] })).toMatchObject({
      numericCount: 2,
      sum: Number.POSITIVE_INFINITY,
      average: null,
    });
  });

  it("keeps pending summaries count-only and formats sum and average identically", () => {
    expect(createPendingSelectionSummary(1_000_000, 100_000)).toEqual({
      cellCount: 1_000_000,
      rowCount: 100_000,
      numericCount: 0,
      sum: 0,
      average: null,
    });
    expect(formatSelectionAggregate(-0, "en-US")).toBe("0");
    expect(formatSelectionAggregate(1 / 3, "en-US")).toBe("0.333333333333");
    expect(formatSelectionAggregate(2.5, "en-US")).toBe("2.5");
    expect(formatSelectionAverage(1 / 3, "en-US")).toBe("0.333333333333");
    expect(formatSelectionAverage(null, "en-US")).toBe("—");
    expect(formatSelectionAverage(Number.POSITIVE_INFINITY, "en-US")).toBe("—");
  });

  it("dedupeColumnIndexes preserves the first visible occurrence instead of sorting", () => {
    // After drag-reordering, visible order is [2, 0, 1]; extraction must keep it,
    // not revert to numeric [0, 1, 2].
    expect(dedupeColumnIndexes([2, 0, 1])).toEqual([2, 0, 1]);
  });

  it("dedupeColumnIndexes dedups keeping the first occurrence and drops negatives", () => {
    expect(dedupeColumnIndexes([2, 0, 2, -1, 1, 0])).toEqual([2, 0, 1]);
  });
});
