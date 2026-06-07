export interface DataGridPaintTheme {
  background: string;
  border: string;
  foreground: string;
  mutedForeground: string;
  primary: string;
  rowMuted: string;
  rowNew: string;
  rowDeleted: string;
  cellActive: string;
  cellDirty: string;
  cellSelected: string;
  cellSelectedDirty: string;
  cellSelectedBorder: string;
  cellHover: string;
  cellSearch: string;
  cellCurrentSearch: string;
  cellCurrentSearchBorder: string;
  rowNumberDefault: string;
  rowNumberNew: string;
  rowNumberEdited: string;
  rowNumberDeleted: string;
  rowNumberActive: string;
  rowNumberSelected: string;
  rowNumberTextClean: string;
  rowNumberTextNew: string;
  rowNumberTextEdited: string;
  rowNumberTextDeleted: string;
}

export const DATA_GRID_DARK_SEARCH_COLORS = {
  match: "rgb(72 57 8)",
  current: "rgb(116 87 0)",
  currentBorder: "rgb(239 177 0)",
} as const;
export const DATA_GRID_DARK_ROW_NUMBER_BG = "rgb(35 37 42)";
const DATA_GRID_DARK_ROW_NUMBER_NEW_BG = "rgb(33 45 40)";
const DATA_GRID_DARK_ROW_NUMBER_EDITED_BG = "rgb(48 41 28)";
const DATA_GRID_DARK_ROW_NUMBER_DELETED_BG = "rgb(55 31 32)";
const DATA_GRID_LIGHT_ROW_NUMBER_NEW_BG = "rgb(219 244 233)";
const DATA_GRID_LIGHT_ROW_NUMBER_EDITED_BG = "rgb(253 241 219)";
const DATA_GRID_LIGHT_ROW_NUMBER_DELETED_BG = "rgb(255 244 244)";
const SUPPORTS_COLOR_MIX =
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("color", "color-mix(in oklab, black 50%, white)");
const SUPPORTS_OKLCH =
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("color", "oklch(0.845 0.143 164.978)");

function colorValue(fallback: string, preferred: string, supported: boolean): string {
  return supported ? preferred : fallback;
}

export function cssVarColor(getVar: (name: string) => string, name: string, fallback: string): string {
  const value = getVar(name).trim();
  if (!value) return fallback;
  return value.startsWith("#") || /^(rgb|hsl|oklch|oklab|lab|lch|color-mix)\(/.test(value) ? value : `hsl(${value})`;
}

function resolveCssVarReferences(value: string, getVar: (name: string) => string, depth = 0): string {
  if (depth > 6 || !value.includes("var(")) return value;
  return value.replace(/var\(\s*(--[\w-]+)(?:\s*,\s*([^)]+))?\s*\)/g, (_match, name: string, fallback?: string) => {
    const resolved = getVar(name).trim() || fallback?.trim() || "";
    if (!resolved) return "";
    const nested = resolveCssVarReferences(resolved, getVar, depth + 1);
    return cssVarColor(() => nested, name, nested);
  });
}

function paintToken(getVar: (name: string) => string, name: string, fallback: string): string {
  const value = resolveCssVarReferences(getVar(name).trim(), getVar);
  if (!value) return fallback;
  return value.startsWith("#") || /^(rgb|hsl|oklch|oklab|lab|lch|color-mix)\(/.test(value)
    ? value
    : cssVarColor(() => value, name, fallback);
}

export function resolveDataGridPaintTheme(options: {
  getVar: (name: string) => string;
  isDark: boolean;
}): DataGridPaintTheme {
  const { getVar, isDark } = options;
  const background = cssVarColor(getVar, "--background", isDark ? "rgb(19 20 22)" : "rgb(255 255 255)");
  const foreground = cssVarColor(getVar, "--foreground", isDark ? "rgb(215 215 219)" : "rgb(10 10 10)");
  const mutedForeground = cssVarColor(getVar, "--muted-foreground", isDark ? "rgb(151 152 157)" : "rgb(115 115 115)");
  const primary = cssVarColor(getVar, "--primary", isDark ? "rgb(208 208 214)" : "rgb(23 23 23)");
  const destructive = cssVarColor(getVar, "--destructive", isDark ? "rgb(243 98 95)" : "rgb(231 0 11)");
  const accent = cssVarColor(getVar, "--accent", isDark ? "rgb(46 47 51)" : "rgb(245 245 245)");
  const activeSurface = isDark
    ? "rgb(64 64 64)"
    : colorValue("rgb(232 232 232)", `color-mix(in oklab, ${primary} 10%, ${background})`, SUPPORTS_COLOR_MIX);
  const rowMuted = colorValue(
    isDark ? "rgb(32 32 34)" : "rgb(248 248 248)",
    `color-mix(in oklab, ${cssVarColor(getVar, "--muted", isDark ? "rgb(42 42 45)" : "rgb(245 245 245)")} 30%, transparent)`,
    SUPPORTS_COLOR_MIX,
  );
  const rowNew = colorValue(
    isDark ? "rgb(51 51 55)" : "rgb(243 243 243)",
    `color-mix(in oklab, ${primary} 5%, transparent)`,
    SUPPORTS_COLOR_MIX,
  );
  const rowDeleted = colorValue(
    isDark ? "rgb(55 31 32)" : "rgb(255 244 244)",
    `color-mix(in oklab, ${destructive} 5%, transparent)`,
    SUPPORTS_COLOR_MIX,
  );
  const cellActive = activeSurface;
  const cellDirty = colorValue(
    isDark ? "rgb(94 75 26)" : "rgb(255 248 230)",
    `color-mix(in oklab, ${colorValue("rgb(240 177 0)", "oklch(0.795 0.184 86.047)", SUPPORTS_OKLCH)} 10%, transparent)`,
    SUPPORTS_COLOR_MIX,
  );
  const cellSelected = colorValue(
    isDark ? "rgb(66 67 70)" : "rgb(226 226 226)",
    `color-mix(in oklab, ${primary} 25%, transparent)`,
    SUPPORTS_COLOR_MIX,
  );
  const cellSelectedDirty = colorValue(
    isDark ? "rgb(94 75 26)" : "rgb(244 229 186)",
    `color-mix(in oklab, ${colorValue("rgb(234 181 50)", "oklch(0.8 0.15 85)", SUPPORTS_OKLCH)} 30%, color-mix(in oklab, ${primary} 18%, transparent))`,
    SUPPORTS_COLOR_MIX,
  );
  const cellSelectedBorder = colorValue(
    isDark ? "rgb(170 170 175)" : "rgb(90 90 90)",
    `color-mix(in oklab, ${primary} 70%, transparent)`,
    SUPPORTS_COLOR_MIX,
  );
  const cellHover = colorValue(accent, `color-mix(in oklab, ${accent} 50%, transparent)`, SUPPORTS_COLOR_MIX);
  const cellSearch = isDark ? DATA_GRID_DARK_SEARCH_COLORS.match : "rgb(253 245 184)";
  const cellCurrentSearch = isDark ? DATA_GRID_DARK_SEARCH_COLORS.current : "rgb(253 224 71 / 52%)";
  const cellCurrentSearchBorder = isDark ? DATA_GRID_DARK_SEARCH_COLORS.currentBorder : "rgb(234 179 8 / 82%)";
  const rowNumberDefault = isDark
    ? DATA_GRID_DARK_ROW_NUMBER_BG
    : paintToken(getVar, "--data-grid-row-number-default-bg", "rgb(255 255 255)");
  const rowNumberNew = colorValue(
    isDark ? DATA_GRID_DARK_ROW_NUMBER_NEW_BG : DATA_GRID_LIGHT_ROW_NUMBER_NEW_BG,
    `color-mix(in oklab, rgb(16 185 129) 15%, ${background})`,
    SUPPORTS_COLOR_MIX,
  );
  const rowNumberEdited = colorValue(
    isDark ? DATA_GRID_DARK_ROW_NUMBER_EDITED_BG : DATA_GRID_LIGHT_ROW_NUMBER_EDITED_BG,
    `color-mix(in oklab, rgb(245 158 11) 15%, ${background})`,
    SUPPORTS_COLOR_MIX,
  );
  const rowNumberDeleted = colorValue(
    isDark ? DATA_GRID_DARK_ROW_NUMBER_DELETED_BG : DATA_GRID_LIGHT_ROW_NUMBER_DELETED_BG,
    `color-mix(in oklab, ${destructive} 15%, ${background})`,
    SUPPORTS_COLOR_MIX,
  );
  const rowNumberActive = activeSurface;
  const rowNumberSelected = cellSelected;

  return {
    background,
    border: cssVarColor(getVar, "--border", isDark ? "rgb(63 63 70)" : "rgb(229 231 235)"),
    foreground,
    mutedForeground,
    primary,
    rowMuted: paintToken(getVar, "--data-grid-row-muted-bg", rowMuted),
    rowNew: paintToken(getVar, "--data-grid-row-new-bg", rowNew),
    rowDeleted: paintToken(getVar, "--data-grid-row-deleted-bg", rowDeleted),
    cellActive: paintToken(getVar, "--data-grid-cell-active-bg", cellActive),
    cellDirty: paintToken(getVar, "--data-grid-cell-dirty-bg", cellDirty),
    cellSelected: paintToken(getVar, "--data-grid-cell-selected-bg", cellSelected),
    cellSelectedDirty: paintToken(getVar, "--data-grid-cell-selected-dirty-bg", cellSelectedDirty),
    cellSelectedBorder: paintToken(getVar, "--data-grid-cell-selected-border", cellSelectedBorder),
    cellHover: paintToken(getVar, "--data-grid-cell-hover-bg", cellHover),
    cellSearch: paintToken(getVar, "--data-grid-cell-search-bg", cellSearch),
    cellCurrentSearch: paintToken(getVar, "--data-grid-cell-current-search-bg", cellCurrentSearch),
    cellCurrentSearchBorder: paintToken(getVar, "--data-grid-cell-current-search-border", cellCurrentSearchBorder),
    rowNumberDefault,
    rowNumberNew: paintToken(getVar, "--data-grid-row-number-new-bg", rowNumberNew),
    rowNumberEdited: paintToken(getVar, "--data-grid-row-number-edited-bg", rowNumberEdited),
    rowNumberDeleted: paintToken(getVar, "--data-grid-row-number-deleted-bg", rowNumberDeleted),
    rowNumberActive: paintToken(getVar, "--data-grid-row-number-active-bg", rowNumberActive),
    rowNumberSelected: paintToken(getVar, "--data-grid-row-number-selected-bg", rowNumberSelected),
    rowNumberTextClean: mutedForeground,
    rowNumberTextNew: colorValue(
      isDark ? "rgb(94 233 181)" : "rgb(0 122 85)",
      isDark ? "oklch(0.845 0.143 164.978)" : "oklch(0.508 0.118 165.612)",
      SUPPORTS_OKLCH,
    ),
    rowNumberTextEdited: colorValue(
      isDark ? "rgb(255 210 48)" : "rgb(187 77 0)",
      isDark ? "oklch(0.879 0.169 91.605)" : "oklch(0.555 0.163 48.998)",
      SUPPORTS_OKLCH,
    ),
    rowNumberTextDeleted: destructive,
  };
}
