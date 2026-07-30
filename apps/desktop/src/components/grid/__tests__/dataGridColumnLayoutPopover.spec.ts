import { describe, expect, it } from "vitest";
import { DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT, dataGridColumnLayoutVirtualWindow } from "../dataGridColumnLayoutPopover";

describe("data grid column layout popover", () => {
  it("renders only the visible field window plus a bounded buffer", () => {
    const window = dataGridColumnLayoutVirtualWindow({
      itemCount: 500,
      scrollTop: 1400,
      viewportHeight: 280,
    });

    expect(window).toEqual({
      start: 44,
      end: 66,
      offsetTop: 44 * DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT,
      totalHeight: 500 * DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT,
    });
  });

  it("clamps the virtual field window at the list boundaries", () => {
    expect(dataGridColumnLayoutVirtualWindow({ itemCount: 4, scrollTop: 9999 })).toMatchObject({
      start: 0,
      end: 4,
      totalHeight: 4 * DATA_GRID_COLUMN_LAYOUT_ROW_HEIGHT,
    });
  });
});
