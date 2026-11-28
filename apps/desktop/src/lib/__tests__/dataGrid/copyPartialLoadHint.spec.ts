import { describe, expect, it } from "vitest";
import { coversAllLoadedRows, isPartiallyLoadedCopy, partialLoadCopyHintKey } from "@/lib/dataGrid/copyPartialLoadHint";

describe("partial-load copy hint", () => {
  it("flags copies as partial when the backend reported more rows", () => {
    expect(isPartiallyLoadedCopy({ loadedRows: 50, totalRows: null, hasMore: true })).toBe(true);
    expect(isPartiallyLoadedCopy({ loadedRows: 50, totalRows: 51, hasMore: false })).toBe(true);
    expect(isPartiallyLoadedCopy({ loadedRows: 50, totalRows: 50, hasMore: false })).toBe(false);
    expect(isPartiallyLoadedCopy({ loadedRows: 50, totalRows: null, hasMore: false })).toBe(false);
  });

  it("never flags an empty grid", () => {
    expect(isPartiallyLoadedCopy({ loadedRows: 0, totalRows: 51, hasMore: true })).toBe(false);
  });

  it("picks the hint variant by whether the total is known", () => {
    expect(partialLoadCopyHintKey({ loadedRows: 50, totalRows: 51, hasMore: false })).toBe("grid.copyPartialRowsHintWithTotal");
    expect(partialLoadCopyHintKey({ loadedRows: 50, totalRows: null, hasMore: true })).toBe("grid.copyPartialRowsHint");
  });

  it("only lets the hint describe copies that took every loaded row (#15602)", () => {
    const info = { loadedRows: 100, totalRows: 6092, hasMore: true };
    expect(coversAllLoadedRows(info, 100)).toBe(true);
    expect(coversAllLoadedRows(info, 101)).toBe(true);
    // Two checked rows, a cell range or one right-clicked cell.
    expect(coversAllLoadedRows(info, 2)).toBe(false);
    expect(coversAllLoadedRows(info, 1)).toBe(false);
    expect(coversAllLoadedRows(info, 0)).toBe(false);
  });

  it("never claims rows when the grid holds none", () => {
    expect(coversAllLoadedRows({ loadedRows: 0, totalRows: 6092, hasMore: true }, 0)).toBe(false);
    expect(coversAllLoadedRows({ loadedRows: 0, totalRows: null, hasMore: false }, 5)).toBe(false);
  });
});
