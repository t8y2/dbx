import { describe, expect, it } from "vitest";
import { formatSelectionAsTsv, summarizeSelection } from "@/lib/dataGrid/gridSelection";

describe("gridSelection", () => {
  it("formats TSV selections without headers by default", () => {
    expect(
      formatSelectionAsTsv({
        columns: ["id", "name"],
        rows: [
          [1, "Ada"],
          [2, "Lin"],
        ],
      }),
    ).toBe("1\tAda\n2\tLin");
  });

  it("can include column headers in TSV selections", () => {
    expect(
      formatSelectionAsTsv(
        {
          columns: ["id", "name"],
          rows: [
            [1, "Ada"],
            [2, "Lin"],
          ],
        },
        true,
      ),
    ).toBe("id\tname\n1\tAda\n2\tLin");
  });

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
});
