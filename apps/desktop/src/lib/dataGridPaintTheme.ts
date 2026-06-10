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
  match: "rgb(72, 57, 8)",
  current: "rgb(116, 87, 0)",
  currentBorder: "rgb(239, 177, 0)",
} as const;
export const DATA_GRID_DARK_ROW_NUMBER_BG = "rgb(35, 37, 42)";
const DATA_GRID_DARK_ROW_NUMBER_NEW_BG = "rgb(33, 45, 40)";
const DATA_GRID_DARK_ROW_NUMBER_EDITED_BG = "rgb(48, 41, 28)";
const DATA_GRID_DARK_ROW_NUMBER_DELETED_BG = "rgb(55, 31, 32)";
const DATA_GRID_LIGHT_ROW_NUMBER_NEW_BG = "rgb(219, 244, 233)";
const DATA_GRID_LIGHT_ROW_NUMBER_EDITED_BG = "rgb(253, 241, 219)";
const DATA_GRID_LIGHT_ROW_NUMBER_DELETED_BG = "rgb(255, 244, 244)";
const CANVAS_SAFE_COLOR_RE = /^(#|rgb\(|rgba\(|hsl\(|hsla\()/i;
const ADVANCED_COLOR_RE = /^(oklch\(|oklab\(|lab\(|lch\(|color\(|color-mix\()/i;
let browserColorProbe: HTMLElement | null = null;

interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseAlpha(value: string | undefined): number {
  if (!value) return 1;
  const trimmed = value.trim();
  if (trimmed.endsWith("%")) return clamp(Number.parseFloat(trimmed) / 100, 0, 1);
  return clamp(Number.parseFloat(trimmed), 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function formatAlpha(value: number): string {
  return Number(clamp(value, 0, 1).toFixed(3)).toString();
}

function formatRgb(color: RgbaColor): string {
  const r = Math.round(clamp(color.r, 0, 255));
  const g = Math.round(clamp(color.g, 0, 255));
  const b = Math.round(clamp(color.b, 0, 255));
  if (color.a < 1) return `rgba(${r}, ${g}, ${b}, ${formatAlpha(color.a)})`;
  return `rgb(${r}, ${g}, ${b})`;
}

function parseRgbColor(value: string): RgbaColor | null {
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const fullHex = hex.length === 3 ? [...hex].map((char) => `${char}${char}`).join("") : hex;
    return {
      r: Number.parseInt(fullHex.slice(0, 2), 16),
      g: Number.parseInt(fullHex.slice(2, 4), 16),
      b: Number.parseInt(fullHex.slice(4, 6), 16),
      a: 1,
    };
  }

  const rgb = value.match(/^rgba?\((.+)\)$/i)?.[1]?.trim();
  if (!rgb) return null;
  const parts = rgb.includes(",") ? rgb.split(",").map((part) => part.trim()) : rgb.replace(/\s+\/\s+/, " / ").split(/\s+/);
  const slashIndex = parts.indexOf("/");
  const channels = slashIndex >= 0 ? parts.slice(0, slashIndex) : parts.slice(0, 3);
  const alpha = slashIndex >= 0 ? parts[slashIndex + 1] : parts[3];
  if (channels.length < 3) return null;
  const [r, g, b] = channels.map((part) => Number.parseFloat(part));
  if ([r, g, b].some((channel) => Number.isNaN(channel))) return null;
  return { r, g, b, a: parseAlpha(alpha) };
}

function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function parseColorStop(value: string): { color: string; percent?: number } | null {
  const match = value.match(/^(.*)\s+([0-9.]+)%$/);
  if (!match) return { color: value.trim() };
  return {
    color: match[1]?.trim() ?? "",
    percent: Number.parseFloat(match[2] ?? ""),
  };
}

function mixRgb(first: RgbaColor, firstPercent: number, second: RgbaColor, secondPercent: number): RgbaColor {
  const total = firstPercent + secondPercent || 100;
  const firstWeight = firstPercent / total;
  const secondWeight = secondPercent / total;
  return {
    r: first.r * firstWeight + second.r * secondWeight,
    g: first.g * firstWeight + second.g * secondWeight,
    b: first.b * firstWeight + second.b * secondWeight,
    a: first.a * firstWeight + second.a * secondWeight,
  };
}

function parseColorMix(value: string): string | null {
  const body = value.match(/^color-mix\(\s*in\s+oklab\s*,\s*(.*)\)$/i)?.[1];
  if (!body) return null;
  const [firstRaw, secondRaw] = splitTopLevelCommas(body);
  if (!firstRaw || !secondRaw) return null;
  const first = parseColorStop(firstRaw);
  const second = parseColorStop(secondRaw);
  if (!first?.color || !second?.color || first.percent === undefined) return null;
  const firstColor = parseRgbColor(toCanvasSafeColor(first.color, ""));
  if (!firstColor) return null;
  const secondPercent = second.percent ?? 100 - first.percent;
  if (second.color.toLowerCase() === "transparent") {
    return formatRgb({ ...firstColor, a: firstColor.a * (first.percent / 100) });
  }
  const secondColor = parseRgbColor(toCanvasSafeColor(second.color, ""));
  if (!secondColor) return null;
  return formatRgb(mixRgb(firstColor, first.percent, secondColor, secondPercent));
}

function normalizeCssColorWithBrowser(value: string): string | null {
  if (typeof document === "undefined") return null;
  try {
    browserColorProbe ??= document.createElement("span");
    const probe = browserColorProbe;
    probe.style.color = "";
    probe.style.color = value;
    if (!probe.style.color) return null;
    if (!probe.isConnected) {
      probe.style.position = "absolute";
      probe.style.left = "-9999px";
      probe.style.top = "-9999px";
      probe.style.visibility = "hidden";
      document.body?.appendChild(probe);
    }
    const computed = getComputedStyle(probe).color.trim();
    return computed || null;
  } catch {
    return null;
  }
}

function toCanvasSafeColor(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  const rgb = parseRgbColor(trimmed);
  if (rgb) return formatRgb(rgb);
  if (CANVAS_SAFE_COLOR_RE.test(trimmed)) return trimmed;
  if (ADVANCED_COLOR_RE.test(trimmed)) return normalizeCssColorWithBrowser(trimmed) ?? parseColorMix(trimmed) ?? fallback;
  return `hsl(${trimmed})`;
}

export function cssVarColor(getVar: (name: string) => string, name: string, fallback: string): string {
  return toCanvasSafeColor(getVar(name), fallback);
}

function resolveCssVarReferences(value: string, getVar: (name: string) => string, depth = 0): string {
  if (depth > 6 || !value.includes("var(")) return value;
  return value.replace(/var\(\s*(--[\w-]+)(?:\s*,\s*([^)]+))?\s*\)/g, (_match, name: string, fallback?: string) => {
    const resolved = getVar(name).trim() || fallback?.trim() || "";
    if (!resolved) return "";
    return resolveCssVarReferences(resolved, getVar, depth + 1);
  });
}

function paintToken(getVar: (name: string) => string, name: string, fallback: string): string {
  const value = resolveCssVarReferences(getVar(name).trim(), getVar);
  return toCanvasSafeColor(value, fallback);
}

export function resolveDataGridPaintTheme(options: { getVar: (name: string) => string; isDark: boolean }): DataGridPaintTheme {
  const { getVar, isDark } = options;
  const background = cssVarColor(getVar, "--background", isDark ? "rgb(19, 20, 22)" : "rgb(255, 255, 255)");
  const foreground = cssVarColor(getVar, "--foreground", isDark ? "rgb(215, 215, 219)" : "rgb(10, 10, 10)");
  const mutedForeground = cssVarColor(getVar, "--muted-foreground", isDark ? "rgb(151, 152, 157)" : "rgb(115, 115, 115)");
  const primary = cssVarColor(getVar, "--primary", isDark ? "rgb(208, 208, 214)" : "rgb(23, 23, 23)");
  const destructive = cssVarColor(getVar, "--destructive", isDark ? "rgb(243, 98, 95)" : "rgb(231, 0, 11)");
  const accent = cssVarColor(getVar, "--accent", isDark ? "rgb(46, 47, 51)" : "rgb(245, 245, 245)");
  const activeSurface = isDark ? "rgb(64, 64, 64)" : "rgb(232, 232, 232)";
  const rowMuted = isDark ? "rgb(32, 32, 34)" : "rgb(248, 248, 248)";
  const rowNew = isDark ? "rgb(51, 51, 55)" : "rgb(243, 243, 243)";
  const rowDeleted = isDark ? "rgb(55, 31, 32)" : "rgb(255, 244, 244)";
  const cellActive = activeSurface;
  const cellDirty = isDark ? "rgb(94, 75, 26)" : "rgb(255, 248, 230)";
  const cellSelected = isDark ? "rgb(66, 67, 70)" : "rgb(226, 226, 226)";
  const cellSelectedDirty = isDark ? "rgb(94, 75, 26)" : "rgb(244, 229, 186)";
  const cellSelectedBorder = isDark ? "rgb(170, 170, 175)" : "rgb(90, 90, 90)";
  const cellHover = accent;
  const cellSearch = isDark ? DATA_GRID_DARK_SEARCH_COLORS.match : "rgb(253, 245, 184)";
  const cellCurrentSearch = isDark ? DATA_GRID_DARK_SEARCH_COLORS.current : "rgba(253, 224, 71, 0.52)";
  const cellCurrentSearchBorder = isDark ? DATA_GRID_DARK_SEARCH_COLORS.currentBorder : "rgba(234, 179, 8, 0.82)";
  const rowNumberDefault = isDark ? DATA_GRID_DARK_ROW_NUMBER_BG : paintToken(getVar, "--data-grid-row-number-default-bg", "rgb(255, 255, 255)");
  const rowNumberNew = isDark ? DATA_GRID_DARK_ROW_NUMBER_NEW_BG : DATA_GRID_LIGHT_ROW_NUMBER_NEW_BG;
  const rowNumberEdited = isDark ? DATA_GRID_DARK_ROW_NUMBER_EDITED_BG : DATA_GRID_LIGHT_ROW_NUMBER_EDITED_BG;
  const rowNumberDeleted = isDark ? DATA_GRID_DARK_ROW_NUMBER_DELETED_BG : DATA_GRID_LIGHT_ROW_NUMBER_DELETED_BG;
  const rowNumberActive = activeSurface;
  const rowNumberSelected = cellSelected;

  return {
    background,
    border: cssVarColor(getVar, "--border", isDark ? "rgb(63, 63, 70)" : "rgb(229, 231, 235)"),
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
    rowNumberTextNew: isDark ? "rgb(94, 233, 181)" : "rgb(0, 122, 85)",
    rowNumberTextEdited: isDark ? "rgb(255, 210, 48)" : "rgb(187, 77, 0)",
    rowNumberTextDeleted: destructive,
  };
}
