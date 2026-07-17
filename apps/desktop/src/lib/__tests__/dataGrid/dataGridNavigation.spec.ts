import { describe, expect, it } from "vitest";
import { moveDataGridCell, navigateDataGridCell } from "@/lib/dataGrid/dataGridNavigation";

const bounds = { rowCount: 3, visibleColumnCount: 4 };

describe("dataGridNavigation", () => {
  it("clamps directional movement to grid boundaries", () => {
    expect(moveDataGridCell({ rowIndex: 0, colIndex: 0 }, -1, -1, bounds)).toEqual({ rowIndex: 0, colIndex: 0 });
    expect(moveDataGridCell({ rowIndex: 2, colIndex: 3 }, 1, 1, bounds)).toEqual({ rowIndex: 2, colIndex: 3 });
    expect(moveDataGridCell({ rowIndex: 1, colIndex: 2 }, -1, 1, bounds)).toEqual({ rowIndex: 0, colIndex: 3 });
  });

  it("supports home and end navigation without changing the row", () => {
    expect(navigateDataGridCell({ rowIndex: 2, colIndex: 2 }, "home", bounds)).toEqual({ rowIndex: 2, colIndex: 0 });
    expect(navigateDataGridCell({ rowIndex: 2, colIndex: 0 }, "end", bounds)).toEqual({ rowIndex: 2, colIndex: 3 });
  });

  it("returns no target for an empty grid", () => {
    expect(navigateDataGridCell({ rowIndex: 0, colIndex: 0 }, "down", { rowCount: 0, visibleColumnCount: 4 })).toBeNull();
  });
});
