import { describe, expect, it } from "vitest";
import { firstResultCellValue } from "@/lib/query/queryResultFirstValue";

describe("firstResultCellValue", () => {
  it("reads the first row's value from the requested column", () => {
    const result = { columns: ["uid", "name", "active"], rows: [[7, "seven", true]] };

    expect(firstResultCellValue(result, 1)).toEqual({ column: "uid", value: "7" });
    expect(firstResultCellValue(result, 2)).toEqual({ column: "name", value: "seven" });
    expect(firstResultCellValue(result, 3)).toEqual({ column: "active", value: "true" });
  });

  it("renders null cells as empty strings", () => {
    expect(firstResultCellValue({ columns: ["a"], rows: [[null]] }, 1)).toEqual({ column: "a", value: "" });
  });

  it("returns null without a result, a first row, or the column", () => {
    expect(firstResultCellValue(undefined, 1)).toBeNull();
    expect(firstResultCellValue({ columns: ["a"], rows: [] }, 1)).toBeNull();
    expect(firstResultCellValue({ columns: ["a"], rows: [["x"]] }, 2)).toBeNull();
    expect(firstResultCellValue({ columns: ["a"], rows: [["x"]] }, 0)).toBeNull();
  });

  it("falls back to a positional label when the column header is missing", () => {
    expect(firstResultCellValue({ columns: [], rows: [["x", "y"]] }, 2)).toEqual({ column: "2", value: "y" });
  });
});
