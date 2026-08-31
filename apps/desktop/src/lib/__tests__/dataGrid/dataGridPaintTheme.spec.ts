import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DATA_GRID_DARK_ACTIVE_ROW_BG,
  DATA_GRID_DARK_CROSSHAIR_COL_BG,
  DATA_GRID_DARK_CROSSHAIR_ROW_BG,
  DATA_GRID_LIGHT_ACTIVE_ROW_BG,
  DATA_GRID_LIGHT_CROSSHAIR_COL_BG,
  DATA_GRID_LIGHT_CROSSHAIR_ROW_BG,
  dataGridActiveRowBackground,
  resolveDataGridPaintTheme,
} from "@/lib/dataGrid/dataGridPaintTheme";
import { DEFAULT_DATA_GRID_TYPE_COLORS_DARK, DEFAULT_DATA_GRID_TYPE_COLORS_LIGHT, dataGridTypeColorCssVar } from "@/lib/dataGrid/dataGridTypeColorScheme";

function parseRgb(value: string): { r: number; g: number; b: number } | null {
  const hex = value.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  if (hex) return { r: Number.parseInt(hex[1], 16), g: Number.parseInt(hex[2], 16), b: Number.parseInt(hex[3], 16) };
  const match = value.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (!match) return null;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

function contrastRatio(a: string, b: string): number {
  const left = parseRgb(a);
  const right = parseRgb(b);
  if (!left || !right) return 0;
  const l1 = relativeLuminance(left);
  const l2 = relativeLuminance(right);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("data grid paint theme", () => {
  it("uses a subtle active-row surface fallback in both color schemes", () => {
    expect(dataGridActiveRowBackground(false)).toBe(DATA_GRID_LIGHT_ACTIVE_ROW_BG);
    expect(dataGridActiveRowBackground(true)).toBe(DATA_GRID_DARK_ACTIVE_ROW_BG);

    const emptyCssVariable = () => "";
    expect(resolveDataGridPaintTheme({ getVar: emptyCssVariable, isDark: false }).cellActive).toBe(DATA_GRID_LIGHT_ACTIVE_ROW_BG);
    expect(resolveDataGridPaintTheme({ getVar: emptyCssVariable, isDark: false }).rowNumberActive).toBe(DATA_GRID_LIGHT_ACTIVE_ROW_BG);
    expect(resolveDataGridPaintTheme({ getVar: emptyCssVariable, isDark: true }).cellActive).toBe(DATA_GRID_DARK_ACTIVE_ROW_BG);
    expect(resolveDataGridPaintTheme({ getVar: emptyCssVariable, isDark: true }).rowNumberActive).toBe(DATA_GRID_DARK_ACTIVE_ROW_BG);
  });

  it("resolves crosshair row/col fills in both color schemes", () => {
    const emptyCssVariable = () => "";

    const light = resolveDataGridPaintTheme({ getVar: emptyCssVariable, isDark: false });
    const dark = resolveDataGridPaintTheme({ getVar: emptyCssVariable, isDark: true });

    // 十字底色必须比 cellActive 更明显（与 cellActive 不同、列比行更深的蓝色系）
    expect(light.cellCrosshairRow).toBe(DATA_GRID_LIGHT_CROSSHAIR_ROW_BG);
    expect(light.cellCrosshairCol).toBe(DATA_GRID_LIGHT_CROSSHAIR_COL_BG);
    expect(light.cellCrosshairRow).not.toBe(light.cellActive);
    expect(light.cellCrosshairCol).not.toBe(light.cellActive);
    expect(light.cellCrosshairCol).not.toBe(light.cellCrosshairRow);

    expect(dark.cellCrosshairRow).toBe(DATA_GRID_DARK_CROSSHAIR_ROW_BG);
    expect(dark.cellCrosshairCol).toBe(DATA_GRID_DARK_CROSSHAIR_COL_BG);
    expect(dark.cellCrosshairRow).not.toBe(dark.cellActive);
    expect(dark.cellCrosshairCol).not.toBe(dark.cellActive);
    expect(dark.cellCrosshairCol).not.toBe(dark.cellCrosshairRow);

    // These are spatial location cues rather than text, but they must remain
    // visibly distinct from the grid surface in both modes.
    expect(contrastRatio(light.background, light.cellCrosshairRow)).toBeGreaterThanOrEqual(1.5);
    expect(contrastRatio(light.background, light.cellCrosshairCol)).toBeGreaterThanOrEqual(2);
    expect(contrastRatio(dark.background, dark.cellCrosshairRow)).toBeGreaterThanOrEqual(1.5);
    expect(contrastRatio(dark.background, dark.cellCrosshairCol)).toBeGreaterThanOrEqual(2);
  });

  it("lets explicit crosshair CSS variables drive the canvas fills in light mode", () => {
    const vars: Record<string, string> = {
      "--data-grid-cell-crosshair-row-bg": "rgb(190, 220, 250)",
      "--data-grid-cell-crosshair-col-bg": "rgb(160, 205, 250)",
    };

    const theme = resolveDataGridPaintTheme({ getVar: (name) => vars[name] ?? "", isDark: false });

    expect(theme.cellCrosshairRow).toBe("rgb(190, 220, 250)");
    expect(theme.cellCrosshairCol).toBe("rgb(160, 205, 250)");
  });

  it("uses the theme primary color at the same stronger sRGB ratios as the DOM grid", () => {
    const vars: Record<string, string> = {
      "--primary": "rgb(58, 123, 106)",
      "--background": "rgb(248, 250, 248)",
      "--data-grid-cell-crosshair-row-bg": "color-mix(in srgb, var(--primary) 34%, var(--background))",
      "--data-grid-cell-crosshair-col-bg": "color-mix(in srgb, var(--primary) 50%, var(--background))",
    };

    const theme = resolveDataGridPaintTheme({ getVar: (name) => vars[name] ?? "", isDark: false });

    expect(theme.cellCrosshairRow).toBe("rgb(183, 207, 200)");
    expect(theme.cellCrosshairCol).toBe("rgb(153, 187, 177)");
  });

  it("propagates crosshair fills through the base cell variable so DOM and frozen cells stay visible", () => {
    const gridSource = readFileSync(new URL("../../../components/grid/DataGrid.vue", import.meta.url), "utf8");

    expect(gridSource).toMatch(/\.crosshair-row\s*\{\s*--data-grid-cell-bg:\s*var\(--data-grid-cell-crosshair-row-bg\)\s*!important;/);
    expect(gridSource).toMatch(/\.crosshair-column\s*\{\s*--data-grid-cell-bg:\s*var\(--data-grid-cell-crosshair-col-bg\)\s*!important;/);
    expect(gridSource).toContain("color-mix(in srgb, var(--primary) 34%, var(--background))");
    expect(gridSource).toContain("color-mix(in srgb, var(--primary) 50%, var(--background))");
    expect(gridSource).toMatch(/\.data-grid-cell--frozen\s*\{\s*background-color:\s*var\(--data-grid-cell-bg,/);
  });

  it("falls back to the built-in type palette for the active appearance", () => {
    const emptyCssVariable = () => "";

    expect(resolveDataGridPaintTheme({ getVar: emptyCssVariable, isDark: false }).typeForegrounds.integer).toBe(DEFAULT_DATA_GRID_TYPE_COLORS_LIGHT.integer);
    expect(resolveDataGridPaintTheme({ getVar: emptyCssVariable, isDark: true }).typeForegrounds.integer).toBe(DEFAULT_DATA_GRID_TYPE_COLORS_DARK.integer);
  });

  it("lets an overridden type variable drive the canvas foreground", () => {
    // A custom scheme is applied by writing these variables onto the document,
    // so the canvas paint theme has to read them rather than its own defaults.
    const overrides: Record<string, string> = { [dataGridTypeColorCssVar("integer")]: "#123456" };
    const theme = resolveDataGridPaintTheme({ getVar: (name) => overrides[name] ?? "", isDark: false });

    // A resolved variable is normalized to a canvas-safe rgb(); an absent one keeps the raw fallback.
    expect(theme.typeForegrounds.integer).toBe("rgb(18, 52, 86)");
    expect(theme.typeForegrounds.string).toBe(DEFAULT_DATA_GRID_TYPE_COLORS_LIGHT.string);
  });

  it("keeps unknown-typed values on the neutral foreground", () => {
    const theme = resolveDataGridPaintTheme({ getVar: () => "", isDark: false });

    expect(theme.typeForegrounds.unknown).toBe(theme.foreground);
  });

  it("keeps the classic blue selection palette instead of theme accent/ring mixing", () => {
    const vars: Record<string, string> = {
      "--background": "rgb(255, 255, 255)",
      "--foreground": "rgb(10, 10, 10)",
      "--muted-foreground": "rgb(115, 115, 115)",
      "--primary": "rgb(23, 23, 23)",
      "--destructive": "rgb(231, 0, 11)",
      "--accent": "rgb(226, 226, 226)",
      "--border": "rgb(229, 229, 229)",
      "--ring": "rgb(23, 23, 23)",
      "--muted": "rgb(245, 245, 245)",
      "--success": "rgb(22, 163, 74)",
      "--warning": "rgb(217, 119, 6)",
    };

    const light = resolveDataGridPaintTheme({
      getVar: (name) => vars[name] ?? "",
      isDark: false,
    });
    const dark = resolveDataGridPaintTheme({
      getVar: (name) => vars[name] ?? "",
      isDark: true,
    });

    expect(light.cellSelected).toBe("rgb(239, 246, 255)");
    expect(light.cellSelectedBorder).toBe("rgb(59, 130, 246)");
    expect(light.cellSelectedSingle).toBe("rgb(191, 219, 254)");
    expect(light.cellSelectedDirty).toBe("rgb(235, 224, 184)");
    expect(light.cellDirty).toBe("rgb(255, 248, 230)");
    expect(light.rowNumberTextNew).toBe("rgb(0, 122, 85)");
    expect(light.rowNumberTextEdited).toBe("rgb(187, 77, 0)");
    expect(contrastRatio(light.cellSelectedBorder, light.cellSelected)).toBeGreaterThanOrEqual(3);

    expect(dark.cellSelected).toBe("rgb(20, 40, 60)");
    expect(dark.cellSelectedBorder).toBe("rgb(96, 165, 250)");
    expect(dark.cellSelectedSingle).toBe("rgb(30, 64, 96)");
    expect(dark.cellSelectedDirty).toBe("rgb(76, 66, 38)");
    expect(dark.cellDirty).toBe("rgb(94, 75, 26)");
  });

  it("honors an explicit --data-grid-cell-selected-border token when provided in light mode", () => {
    const vars: Record<string, string> = {
      "--background": "rgb(255, 255, 255)",
      "--foreground": "rgb(10, 10, 10)",
      "--muted-foreground": "rgb(115, 115, 115)",
      "--primary": "rgb(23, 23, 23)",
      "--destructive": "rgb(231, 0, 11)",
      "--accent": "rgb(226, 226, 226)",
      "--border": "rgb(229, 229, 229)",
      "--muted": "rgb(245, 245, 245)",
      "--data-grid-cell-selected-border": "rgb(37, 99, 235)",
    };

    const theme = resolveDataGridPaintTheme({
      getVar: (name) => vars[name] ?? "",
      isDark: false,
    });

    expect(theme.cellSelectedBorder).toBe("rgb(37, 99, 235)");
  });

  it("honors explicit --data-grid-cell-dirty-bg token in dark mode when save error occurs", () => {
    const vars: Record<string, string> = {
      "--data-grid-cell-dirty-bg": "rgb(94, 56, 57)",
    };

    const theme = resolveDataGridPaintTheme({
      getVar: (name) => vars[name] ?? "",
      isDark: true,
    });

    expect(theme.cellDirty).toBe("rgb(94, 56, 57)");
  });

  it("resolves accessible semantic type colors for light and dark grids", () => {
    const emptyCssVariable = () => "";
    const light = resolveDataGridPaintTheme({ getVar: emptyCssVariable, isDark: false });
    const dark = resolveDataGridPaintTheme({ getVar: emptyCssVariable, isDark: true });

    expect(light.typeForegrounds.integer).toBe("#1d4ed8");
    expect(light.typeForegrounds.boolean).toBe("#c2410c");
    expect(dark.typeForegrounds.integer).toBe("#93c5fd");
    expect(dark.typeForegrounds.boolean).toBe("#fdba74");
    expect(light.typeForegrounds.unknown).toBe(light.foreground);
    expect(dark.typeForegrounds.unknown).toBe(dark.foreground);

    for (const [kind, color] of Object.entries(light.typeForegrounds)) {
      if (kind === "unknown") continue;
      expect(contrastRatio(color, "#ffffff")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(color, "#f0f0f0")).toBeGreaterThanOrEqual(4.5);
    }
    for (const [kind, color] of Object.entries(dark.typeForegrounds)) {
      if (kind === "unknown") continue;
      expect(contrastRatio(color, "#131416")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(color, "#28282b")).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("honors a custom semantic type color token", () => {
    const theme = resolveDataGridPaintTheme({
      getVar: (name) => (name === "--data-grid-type-spatial-fg" ? "rgb(12, 98, 74)" : ""),
      isDark: false,
    });

    expect(theme.typeForegrounds.spatial).toBe("rgb(12, 98, 74)");
  });
});

describe("dbx-control-chrome cascade contract", () => {
  it("keeps chrome defaults layered and low-specificity so invalid/focus utilities can win", () => {
    const css = readFileSync(new URL("../../../styles/globals.css", import.meta.url), "utf8");
    const chromeBlockStart = css.indexOf("Shared control chrome defaults");
    expect(chromeBlockStart).toBeGreaterThanOrEqual(0);
    const chromeSlice = css.slice(chromeBlockStart - 40, chromeBlockStart + 1600);
    expect(chromeSlice).toMatch(/@layer components/);
    expect(chromeSlice).toMatch(/:where\(\.dbx-control-chrome\)/);
    expect(chromeSlice).toMatch(/\[aria-invalid="true"\]/);
    expect(chromeSlice).not.toMatch(/box-shadow:\s*none/);
  });
});
