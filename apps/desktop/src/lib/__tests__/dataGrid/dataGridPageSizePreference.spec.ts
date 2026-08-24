import { describe, expect, it } from "vitest";
import { dataGridPageSizeSettingsPatch, preferredDataGridPageSize, resolveDataGridPageSizePreference } from "@/lib/dataGrid/dataGridPageSizePreference";

describe("DataGrid page-size preference", () => {
  it("keeps the context-derived defaults for regular result and table-data grids", () => {
    expect(resolveDataGridPageSizePreference("results")).toBe("results");
    expect(resolveDataGridPageSizePreference(undefined)).toBe("results");
    expect(resolveDataGridPageSizePreference("table-data")).toBe("table-open");
  });

  it("allows a result-context grid to explicitly use the table-open preference", () => {
    expect(resolveDataGridPageSizePreference("results", "table-open")).toBe("table-open");
  });

  it("reads the selected preference and preserves an explicit table-data page limit", () => {
    const settings = { pageSize: 25, tableOpenPageSize: 500 };

    expect(preferredDataGridPageSize(settings, "results")).toBe(25);
    expect(preferredDataGridPageSize(settings, "table-open")).toBe(500);
    expect(preferredDataGridPageSize(settings, "table-open", 75)).toBe(75);
    expect(preferredDataGridPageSize({ pageSize: 0, tableOpenPageSize: Number.NaN }, "results")).toBe(100);
    expect(preferredDataGridPageSize({ pageSize: 0, tableOpenPageSize: Number.NaN }, "table-open")).toBe(100);
  });

  it("writes only the selected normalized setting", () => {
    expect(dataGridPageSizeSettingsPatch("results", 250.9)).toEqual({ pageSize: 250 });
    expect(dataGridPageSizeSettingsPatch("table-open", 750.9)).toEqual({ tableOpenPageSize: 750 });
    expect(dataGridPageSizeSettingsPatch("table-open", 0)).toEqual({ tableOpenPageSize: 100 });
  });
});
