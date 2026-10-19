import { describe, expect, it } from "vitest";
import { isDataGridSurfaceBusy, type DataGridSurfaceBusyFlags } from "@/lib/dataGrid/dataGridSurfaceBusy";

const idle: DataGridSurfaceBusyFlags = {
  isRefreshingData: false,
  loading: false,
  lastPageCountLoading: false,
  pageJumpBusy: false,
  rowPreparationActive: false,
};

describe("DataGrid surface busy overlay", () => {
  it("stays open while nothing is loading", () => {
    expect(isDataGridSurfaceBusy(idle)).toBe(false);
  });

  it("masks the grid for real data reloads, page jumps and row preparation", () => {
    expect(isDataGridSurfaceBusy({ ...idle, isRefreshingData: true })).toBe(true);
    expect(isDataGridSurfaceBusy({ ...idle, loading: true })).toBe(true);
    expect(isDataGridSurfaceBusy({ ...idle, pageJumpBusy: true })).toBe(true);
    expect(isDataGridSurfaceBusy({ ...idle, rowPreparationActive: true })).toBe(true);
  });

  it("keeps the grid interactive during a manual total-row count (issue #12652)", () => {
    // The status-bar count button runs a background COUNT(*): no rows are
    // replaced, so the surface must stay unmasked while it runs. The manual
    // count keeps its own flag on the grid (totalRowCountBusy) and is
    // deliberately absent from this interface, which is what keeps the grid
    // selectable and copyable for the whole count.
    expect("manualTotalRowCountLoading" in idle).toBe(false);
    expect(isDataGridSurfaceBusy(idle)).toBe(false);
  });

  it("keeps the mask for the count that precedes a jump to the last page", () => {
    // That count ends in a real page switch, so the surface stays masked.
    expect(isDataGridSurfaceBusy({ ...idle, lastPageCountLoading: true })).toBe(true);
  });
});
