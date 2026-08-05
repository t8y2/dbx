import { describe, expect, it } from "vitest";
import { filterModeIsSupportedForDatabase } from "@/lib/dataGrid/dataGridColumnFilter";
import type { DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";

describe("VictoriaMetrics data grid filters", () => {
  it("does not expose SQL filter modes for MetricsQL results", () => {
    const modes: DataGridContextFilterMode[] = ["equals", "not-equals", "is-null", "is-not-null", "like", "not-like", "less-than", "greater-than", "in", "not-in", "between", "not-between"];

    expect(modes.every((mode) => !filterModeIsSupportedForDatabase(mode, "victoriametrics"))).toBe(true);
    expect(filterModeIsSupportedForDatabase("equals", "postgres")).toBe(true);
  });
});
