import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DATA_GRID_DARK_ACTIVE_ROW_BG, DATA_GRID_LIGHT_ACTIVE_ROW_BG, dataGridActiveRowBackground, resolveDataGridPaintTheme } from "@/lib/dataGrid/dataGridPaintTheme";

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
