import { describe, expect, it } from "vitest";
import { createPendingSelectionSummary, dedupeColumnIndexes, formatSelectionAggregate, formatSelectionAverage, plainSelectionNumericValue, summarizeSelection } from "@/lib/dataGrid/gridSelection";

describe("gridSelection", () => {
  it("summarizes empty selections", () => {
    expect(summarizeSelection({ columns: [], rows: [] })).toEqual({
      cellCount: 0,
      rowCount: 0,
      numericCount: 0,
      sum: "0",
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
      sum: "10",
      average: "2.5",
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
      sum: "105.5",
      average: "35.166666666667",
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
      sum: "0",
      average: null,
    });
  });

  it.each([
    ["single cell", [[8]], 1, 1, "8"],
    ["row", [[1, 3]], 2, 1, "2"],
    ["column", [[1], [3]], 2, 2, "2"],
    [
      "range",
      [
        [1, 2],
        [3, 4],
      ],
      4,
      2,
      "2.5",
    ],
  ] as const)("averages a %s selection without changing its counts", (_label, rows, cellCount, rowCount, average) => {
    expect(summarizeSelection({ columns: [], rows: rows.map((row) => [...row]) })).toMatchObject({ cellCount, rowCount, average });
  });

  it("keeps a sum of finite values finite where a double would overflow", () => {
    // The shortest decimal that round-trips to Number.MAX_VALUE, as the grid shows it.
    const max = `17976931348623157${"0".repeat(292)}`;
    expect(summarizeSelection({ columns: ["value"], rows: [[Number.MAX_VALUE], [Number.MAX_VALUE]] })).toMatchObject({
      numericCount: 2,
      sum: (BigInt(max) * 2n).toString(),
      average: max,
    });
  });

  it("sums integers beyond 2^53 exactly, as MySQL BIGINT text", () => {
    // MySQL returns these for `SUM(big)` / `AVG(big)`; a double prints 1762018465054523400.
    expect(summarizeSelection({ columns: ["big"], rows: [["1762018465054523393"]] })).toMatchObject({
      sum: "1762018465054523393",
      average: "1762018465054523393",
    });
    expect(summarizeSelection({ columns: ["big"], rows: [["1762018465054523393"], ["2041776918834970625"], ["-9007199254740993"]] })).toMatchObject({
      sum: "3794788184634753025",
      average: "1264929394878251008.333333333333",
    });
    expect(summarizeSelection({ columns: ["ubig"], rows: [["18446744073709551615"], ["1"], ["2"]] })).toMatchObject({
      sum: "18446744073709551618",
      average: "6148914691236517206",
    });
  });

  it("sums DECIMAL text digit for digit", () => {
    expect(summarizeSelection({ columns: ["dec4"], rows: [["1234567890123456.7891"], ["9876543210987654.3219"], ["0.0001"]] })).toMatchObject({
      sum: "11111111101111111.1111",
      average: "3703703700370370.370366666667",
    });
    expect(summarizeSelection({ columns: ["value"], rows: [["0.1"], [0.2], ["-0.3"]] })).toMatchObject({ sum: "0", average: "0" });
    expect(summarizeSelection({ columns: ["value"], rows: [["-0.105"], ["-12.345"], ["3.333"]] })).toMatchObject({ sum: "-9.117", average: "-3.039" });
  });

  it("keeps at least the digits of the averaged values and rounds the average half away from zero", () => {
    expect(summarizeSelection({ columns: ["value"], rows: [[1], [1], [2]] })).toMatchObject({ average: "1.333333333333" });
    expect(summarizeSelection({ columns: ["value"], rows: [[1], [2], [2]] })).toMatchObject({ average: "1.666666666667" });
    expect(summarizeSelection({ columns: ["value"], rows: [[-1], [-2], [-2]] })).toMatchObject({ average: "-1.666666666667" });
    expect(summarizeSelection({ columns: ["value"], rows: [["0.00000000000000000001"], ["0"]] })).toMatchObject({ average: "0.000000000000000000005" });
  });

  it("reads exponent and other numeric text by the value it denotes", () => {
    expect(summarizeSelection({ columns: ["value"], rows: [["1e3"], ["1E-7"], [1e21], ["0x10"], ["1e-999999"]] })).toMatchObject({
      numericCount: 5,
      sum: "1000000000000000001016.0000001",
    });
  });

  it("summarizes with a grid-specific numeric resolver", () => {
    // A grid can hand cells over in a shape plain coercion rejects; the resolver
    // decides what takes part, so a column total never silently drops values.
    const numericValue = (value: string | number | boolean | null): number | undefined => {
      const prefixed = typeof value === "string" ? /^#(-?[\d.]+)$/.exec(value) : null;
      if (prefixed) return Number(prefixed[1]);
      return plainSelectionNumericValue(value);
    };
    const selection = { columns: ["value"], rows: [[10], ["-4"], ["#6"], ["#-0.5"], ["x"]] };

    expect(summarizeSelection(selection)).toMatchObject({ numericCount: 2, sum: "6", average: "3" });
    expect(summarizeSelection(selection, { numericValue })).toMatchObject({ numericCount: 4, sum: "11.5", average: "2.875" });
  });

  it("keeps pending summaries count-only and formats sum and average identically", () => {
    expect(createPendingSelectionSummary(1_000_000, 100_000)).toEqual({
      cellCount: 1_000_000,
      rowCount: 100_000,
      numericCount: 0,
      sum: "0",
      average: null,
    });
    expect(formatSelectionAggregate(-0, "en-US")).toBe("0");
    expect(formatSelectionAggregate(1 / 3, "en-US")).toBe("0.333333333333");
    expect(formatSelectionAggregate(2.5, "en-US")).toBe("2.5");
    expect(formatSelectionAverage(1 / 3, "en-US")).toBe("0.333333333333");
    expect(formatSelectionAverage(null, "en-US")).toBe("—");
    expect(formatSelectionAverage(Number.POSITIVE_INFINITY, "en-US")).toBe("—");
  });

  it("formats exact decimal text without a round trip through a double", () => {
    expect(formatSelectionAggregate("1762018465054523393", "en-US")).toBe("1762018465054523393");
    expect(formatSelectionAggregate("-0", "en-US")).toBe("0");
    expect(formatSelectionAggregate("11111111101111111.1111", "en-US")).toBe("11,111,111,101,111,111.1111");
    expect(formatSelectionAggregate("0.000000000000000000005", "en-US")).toBe("0.000000000000000000005");
    expect(formatSelectionAggregate("-1234.5", "de-DE")).toBe("-1.234,5");
    expect(formatSelectionAverage("2.5", "en-US")).toBe("2.5");
  });

  it("ignores non-finite and non-numeric cells in the default resolver", () => {
    expect(plainSelectionNumericValue(2.5)).toBe(2.5);
    expect(plainSelectionNumericValue(" -4 ")).toBe(-4);
    expect(plainSelectionNumericValue(Number.NaN)).toBeUndefined();
    expect(plainSelectionNumericValue(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(plainSelectionNumericValue("   ")).toBeUndefined();
    expect(plainSelectionNumericValue('NumberLong("-6")')).toBeUndefined();
    expect(plainSelectionNumericValue(true)).toBeUndefined();
    expect(plainSelectionNumericValue(null)).toBeUndefined();
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
