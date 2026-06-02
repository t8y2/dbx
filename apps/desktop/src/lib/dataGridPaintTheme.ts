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
  const background = cssVarColor(getVar, "--background", isDark ? "oklch(0.145 0 0)" : "oklch(1 0 0)");
  const foreground = cssVarColor(getVar, "--foreground", isDark ? "oklch(0.985 0 0)" : "oklch(0.145 0 0)");
  const mutedForeground = cssVarColor(getVar, "--muted-foreground", isDark ? "oklch(0.708 0 0)" : "oklch(0.556 0 0)");
  const primary = cssVarColor(getVar, "--primary", isDark ? "oklch(0.922 0 0)" : "oklch(0.205 0 0)");
  const muted = cssVarColor(getVar, "--muted", isDark ? "oklch(0.269 0 0)" : "oklch(0.97 0 0)");
  const destructive = cssVarColor(getVar, "--destructive", "oklch(0.6 0.22 25)");
  const accent = cssVarColor(getVar, "--accent", isDark ? "oklch(0.269 0 0)" : "oklch(0.97 0 0)");
  const yellow500 = "oklch(0.795 0.184 86.047)";
  const activeSurface = isDark ? "rgb(64 64 64)" : `color-mix(in oklab, ${primary} 10%, ${background})`;
  const rowMuted = `color-mix(in oklab, ${muted} 30%, transparent)`;
  const rowNew = `color-mix(in oklab, ${primary} 5%, transparent)`;
  const rowDeleted = `color-mix(in oklab, ${destructive} 5%, transparent)`;
  const cellActive = activeSurface;
  const cellDirty = `color-mix(in oklab, ${yellow500} 10%, transparent)`;
  const cellSelected = `color-mix(in oklab, ${primary} 25%, transparent)`;
  const cellSelectedDirty = `color-mix(in oklab, oklch(0.8 0.15 85) 30%, color-mix(in oklab, ${primary} 18%, transparent))`;
  const cellSelectedBorder = `color-mix(in oklab, ${primary} 70%, transparent)`;
  const cellHover = `color-mix(in oklab, ${accent} 50%, transparent)`;
  const cellSearch = isDark ? DATA_GRID_DARK_SEARCH_COLORS.match : "rgb(253 245 184)";
  const cellCurrentSearch = isDark ? DATA_GRID_DARK_SEARCH_COLORS.current : "rgb(253 224 71 / 52%)";
  const cellCurrentSearchBorder = isDark ? DATA_GRID_DARK_SEARCH_COLORS.currentBorder : "rgb(234 179 8 / 82%)";
  const rowNumberDefault = isDark ? "rgb(15 15 15)" : "rgb(255 255 255)";
  const rowNumberNew = `color-mix(in oklab, rgb(16 185 129) 15%, ${background})`;
  const rowNumberEdited = `color-mix(in oklab, rgb(245 158 11) 15%, ${background})`;
  const rowNumberDeleted = `color-mix(in oklab, ${destructive} 15%, ${background})`;
  const rowNumberActive = activeSurface;
  const rowNumberSelected = `color-mix(in oklab, ${primary} 25%, ${background})`;

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
    rowNumberTextNew: isDark ? "oklch(0.845 0.143 164.978)" : "oklch(0.508 0.118 165.612)",
    rowNumberTextEdited: isDark ? "oklch(0.879 0.169 91.605)" : "oklch(0.555 0.163 48.998)",
    rowNumberTextDeleted: destructive,
  };
}
