import { describe, expect, it } from "vitest";
import { DATA_GRID_DARK_ACTIVE_ROW_BG, DATA_GRID_LIGHT_ACTIVE_ROW_BG, dataGridActiveRowBackground, resolveDataGridPaintTheme } from "@/lib/dataGrid/dataGridPaintTheme";

describe("data grid paint theme", () => {
  it("uses a subtle blue active-row surface in both color schemes", () => {
    expect(dataGridActiveRowBackground(false)).toBe(DATA_GRID_LIGHT_ACTIVE_ROW_BG);
    expect(dataGridActiveRowBackground(true)).toBe(DATA_GRID_DARK_ACTIVE_ROW_BG);

    const emptyCssVariable = () => "";
    expect(resolveDataGridPaintTheme({ getVar: emptyCssVariable, isDark: false }).cellActive).toBe(DATA_GRID_LIGHT_ACTIVE_ROW_BG);
    expect(resolveDataGridPaintTheme({ getVar: emptyCssVariable, isDark: false }).rowNumberActive).toBe(DATA_GRID_LIGHT_ACTIVE_ROW_BG);
    expect(resolveDataGridPaintTheme({ getVar: emptyCssVariable, isDark: true }).cellActive).toBe(DATA_GRID_DARK_ACTIVE_ROW_BG);
    expect(resolveDataGridPaintTheme({ getVar: emptyCssVariable, isDark: true }).rowNumberActive).toBe(DATA_GRID_DARK_ACTIVE_ROW_BG);
  });
});
