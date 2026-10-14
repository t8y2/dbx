import { describe, expect, it } from "vitest";
import { isPartiallyLoadedCopy, partialLoadCopyHintKey } from "@/lib/dataGrid/copyPartialLoadHint";

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
});
