import { describe, expect, it } from "vitest";
import { CANVAS_DATA_GRID_ROW_HEIGHT } from "@/lib/dataGrid/canvasDataGridRenderer";
import { dataGridNavigationOrigin, dataGridPageScrollTop, dataGridRowScrollTop, moveDataGridCell, navigateDataGridCell } from "@/lib/dataGrid/dataGridNavigation";

const bounds = { rowCount: 3, visibleColumnCount: 4 };

describe("dataGridNavigation", () => {
  it("clamps directional movement to grid boundaries", () => {
    expect(moveDataGridCell({ rowIndex: 0, colIndex: 0 }, -1, -1, bounds)).toEqual({ rowIndex: 0, colIndex: 0 });
    expect(moveDataGridCell({ rowIndex: 2, colIndex: 3 }, 1, 1, bounds)).toEqual({ rowIndex: 2, colIndex: 3 });
    expect(moveDataGridCell({ rowIndex: 1, colIndex: 2 }, -1, 1, bounds)).toEqual({ rowIndex: 0, colIndex: 3 });
  });

  it("continues Shift navigation from the selection focus", () => {
    const rangeStart = { rowIndex: 1, colIndex: 1 };
    const selectionFocus = { rowIndex: 3, colIndex: 2 };

    expect(dataGridNavigationOrigin(rangeStart, selectionFocus, true)).toEqual(selectionFocus);
    expect(dataGridNavigationOrigin(rangeStart, selectionFocus, false)).toEqual(rangeStart);
    expect(dataGridNavigationOrigin(rangeStart, null, true)).toEqual(rangeStart);
  });

  it("supports home and end navigation without changing the row", () => {
    expect(navigateDataGridCell({ rowIndex: 2, colIndex: 2 }, "home", bounds)).toEqual({ rowIndex: 2, colIndex: 0 });
    expect(navigateDataGridCell({ rowIndex: 2, colIndex: 0 }, "end", bounds)).toEqual({ rowIndex: 2, colIndex: 3 });
  });

  it("returns no target for an empty grid", () => {
    expect(navigateDataGridCell({ rowIndex: 0, colIndex: 0 }, "down", { rowCount: 0, visibleColumnCount: 4 })).toBeNull();
  });

  it("supports page up and page down by the configured page row count", () => {
    const pageBounds = { rowCount: 10, visibleColumnCount: 4, pageRowCount: 5 };
    expect(navigateDataGridCell({ rowIndex: 7, colIndex: 2 }, "pageUp", pageBounds)).toEqual({ rowIndex: 2, colIndex: 2 });
    expect(navigateDataGridCell({ rowIndex: 2, colIndex: 2 }, "pageDown", pageBounds)).toEqual({ rowIndex: 7, colIndex: 2 });
  });

  it("continues Shift+Page navigation from the range focus", () => {
    const pageBounds = { rowCount: 30, visibleColumnCount: 4, pageRowCount: 10 };
    const anchor = { rowIndex: 5, colIndex: 2 };
    const firstFocus = navigateDataGridCell(dataGridNavigationOrigin(anchor, null, true)!, "pageDown", pageBounds);
    const secondFocus = navigateDataGridCell(dataGridNavigationOrigin(anchor, firstFocus, true)!, "pageDown", pageBounds);

    expect(firstFocus).toEqual({ rowIndex: 15, colIndex: 2 });
    expect(secondFocus).toEqual({ rowIndex: 25, colIndex: 2 });
  });

  it("clamps page navigation at the grid boundaries", () => {
    const pageBounds = { rowCount: 10, visibleColumnCount: 4, pageRowCount: 5 };
    expect(navigateDataGridCell({ rowIndex: 1, colIndex: 2 }, "pageUp", pageBounds)).toEqual({ rowIndex: 0, colIndex: 2 });
    expect(navigateDataGridCell({ rowIndex: 8, colIndex: 2 }, "pageDown", pageBounds)).toEqual({ rowIndex: 9, colIndex: 2 });
  });

  it("falls back to a single row when pageRowCount is omitted", () => {
    expect(navigateDataGridCell({ rowIndex: 1, colIndex: 2 }, "pageUp", bounds)).toEqual({ rowIndex: 0, colIndex: 2 });
    expect(navigateDataGridCell({ rowIndex: 1, colIndex: 2 }, "pageDown", bounds)).toEqual({ rowIndex: 2, colIndex: 2 });
  });

  it("jumps to the first and last cell with docHome and docEnd", () => {
    expect(navigateDataGridCell({ rowIndex: 2, colIndex: 3 }, "docHome", bounds)).toEqual({ rowIndex: 0, colIndex: 0 });
    expect(navigateDataGridCell({ rowIndex: 0, colIndex: 0 }, "docEnd", bounds)).toEqual({ rowIndex: 2, colIndex: 3 });
  });

  it("aligns document jumps to the first and last grid rows", () => {
    expect(dataGridRowScrollTop({ rowIndex: 0, rowHeight: 26, viewportHeight: 260, currentScrollTop: 1200, alignment: "start" })).toBe(0);
    expect(dataGridRowScrollTop({ rowIndex: 99, rowHeight: 26, viewportHeight: 260, currentScrollTop: 0, alignment: "end" })).toBe(2340);
  });

  it("keeps a visible row in place and minimally reveals a row outside the viewport", () => {
    expect(dataGridRowScrollTop({ rowIndex: 12, rowHeight: 26, viewportHeight: 260, currentScrollTop: 260, alignment: "nearest" })).toBe(260);
    expect(dataGridRowScrollTop({ rowIndex: 9, rowHeight: 26, viewportHeight: 260, currentScrollTop: 260, alignment: "nearest" })).toBe(234);
    expect(dataGridRowScrollTop({ rowIndex: 20, rowHeight: 26, viewportHeight: 260, currentScrollTop: 260, alignment: "nearest" })).toBe(286);
  });

  describe.each([
    ["DOM", 26],
    ["Canvas", CANVAS_DATA_GRID_ROW_HEIGHT],
  ])("%s PageUp/PageDown scrolling", (_renderMode, rowHeight) => {
    const maximumScrollTop = 100 * rowHeight - 260;

    it("keeps the focused row at the same viewport-relative position", () => {
      expect(dataGridPageScrollTop({ previousRowIndex: 5, rowIndex: 15, rowHeight, currentScrollTop: 0, maximumScrollTop })).toBe(260);
      expect(dataGridPageScrollTop({ previousRowIndex: 15, rowIndex: 5, rowHeight, currentScrollTop: 260, maximumScrollTop })).toBe(0);
      expect(dataGridPageScrollTop({ previousRowIndex: 10, rowIndex: 20, rowHeight, currentScrollTop: 117, maximumScrollTop })).toBe(377);
    });

    it("clamps scrolling at the upper and lower boundaries", () => {
      expect(dataGridPageScrollTop({ previousRowIndex: 2, rowIndex: 0, rowHeight, currentScrollTop: 0, maximumScrollTop })).toBe(0);
      expect(dataGridPageScrollTop({ previousRowIndex: 97, rowIndex: 99, rowHeight, currentScrollTop: maximumScrollTop, maximumScrollTop })).toBe(maximumScrollTop);
    });
  });
});
