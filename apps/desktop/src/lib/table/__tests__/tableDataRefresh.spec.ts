import { describe, expect, it } from "vitest";
import { canReloadUnavailableDataTab, restoredDataTabReloadFilters } from "@/lib/table/tableDataRefresh";

describe("canReloadUnavailableDataTab", () => {
  it("allows restored data tabs to reload before the grid mounts", () => {
    expect(canReloadUnavailableDataTab({ mode: "data", result: undefined, isExecuting: false })).toBe(true);
  });

  it("does not start duplicate or unrelated reloads", () => {
    expect(canReloadUnavailableDataTab({ mode: "data", result: undefined, isExecuting: true })).toBe(false);
    expect(canReloadUnavailableDataTab({ mode: "query", result: undefined, isExecuting: false })).toBe(false);
  });

  it("keeps populated data tabs on the DataGrid refresh path", () => {
    expect(
      canReloadUnavailableDataTab({
        mode: "data",
        isExecuting: false,
        result: { columns: ["id"], rows: [[1]], row_count: 1, execution_time_ms: 1 },
      }),
    ).toBe(false);
  });
});

describe("restoredDataTabReloadFilters", () => {
  it("carries the restored tab's own filter and sort back into the reload (#7963)", () => {
    expect(restoredDataTabReloadFilters({ whereInput: "status = 'active'", orderByInput: "name DESC" })).toEqual({
      whereInput: "status = 'active'",
      orderBy: "name DESC",
    });
  });

  it("reports blank filters as absent so the reload does not emit an empty WHERE/ORDER BY", () => {
    expect(restoredDataTabReloadFilters({ whereInput: "", orderByInput: undefined })).toEqual({ whereInput: undefined, orderBy: undefined });
    expect(restoredDataTabReloadFilters({ whereInput: "   ", orderByInput: "  " })).toEqual({ whereInput: undefined, orderBy: undefined });
  });
});
