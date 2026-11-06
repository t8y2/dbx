import { describe, expect, it } from "vitest";
import { shouldRefitColumnWidthsOnRowsChange } from "@/lib/dataGrid/dataGridColumnWidth";

describe("shouldRefitColumnWidthsOnRowsChange", () => {
  it("refits when a different rows array replaces the previous rows", () => {
    expect(shouldRefitColumnWidthsOnRowsChange([], [[1]], undefined)).toBe(true);
  });

  it("does not refit for a load-more page appended to the same result", () => {
    expect(shouldRefitColumnWidthsOnRowsChange([], [[1]], 20)).toBe(false);
  });

  it("does not refit the initial rows, an unchanged array, or a missing array", () => {
    const rows = [[1]];
    expect(shouldRefitColumnWidthsOnRowsChange(undefined, rows, undefined)).toBe(false);
    expect(shouldRefitColumnWidthsOnRowsChange(rows, rows, undefined)).toBe(false);
  });
});
