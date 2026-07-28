import { describe, expect, it } from "vitest";
import { dedupeColumnIndexes, summarizeSelection } from "@/lib/dataGrid/gridSelection";

describe("gridSelection", () => {
  it("summarizes empty selections", () => {
    expect(summarizeSelection({ columns: [], rows: [] })).toEqual({
      cellCount: 0,
      rowCount: 0,
      numericCount: 0,
      sum: 0,
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
    });
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
