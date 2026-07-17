import { describe, expect, it } from "vitest";
import { canReloadUnavailableDataTab } from "@/lib/table/tableDataRefresh";

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
