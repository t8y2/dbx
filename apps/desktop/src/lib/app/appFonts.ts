export const APP_FONT_SANS_CSS_VAR = "--font-sans";
export const FONT_MONO_CSS_VAR = "--font-mono";
export const EDITOR_FONT_FAMILY_CSS_VAR = "--dbx-editor-font-family";
export const DATA_GRID_FONT_FAMILY_CSS_VAR = "--dbx-data-grid-font-family";

export const DEFAULT_UI_FONT_FAMILY = `"Geist Variable", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif`;
// Keep the generic monospace family before CJK fallbacks. CSS chooses a font
// per glyph, so placing PingFang/Microsoft YaHei first also makes ASCII SQL
// render proportionally when the named coding fonts are unavailable. CJK
// glyphs still fall through to these fonts when the monospace face lacks them
// (dbx#674, dbx#1510).
export const DEFAULT_MONO_FALLBACK_FONTS = `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei"`;

// Keep in sync with the editor font default in settingsStore; also the baseline
// `--font-mono` value in tokens.css, which plugin sandboxes consume via the bridge.
export const DEFAULT_MONO_FONT_FAMILY = `'Fira Code', 'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', ${DEFAULT_MONO_FALLBACK_FONTS}`;
export const DEFAULT_DATA_GRID_FONT_FAMILY = `"Geist Variable Tabular", "Geist Variable", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;

// Native-feeling UI option without DBX's bundled/brand font at the front of the stack.
export const SYSTEM_UI_FONT_FAMILY = `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;

export const FONT_FAMILIES: { value: string; label: string }[] = [
  { value: `'Fira Code', 'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', ${DEFAULT_MONO_FALLBACK_FONTS}`, label: "Fira Code" },
  { value: `'JetBrains Mono', 'Fira Code', ${DEFAULT_MONO_FALLBACK_FONTS}`, label: "JetBrains Mono" },
  { value: `'Cascadia Code', 'Cascadia Mono', ${DEFAULT_MONO_FALLBACK_FONTS}`, label: "Cascadia Code" },
  { value: `'Source Code Pro', ${DEFAULT_MONO_FALLBACK_FONTS}`, label: "Source Code Pro" },
  { value: `'SF Mono', 'Menlo', ${DEFAULT_MONO_FALLBACK_FONTS}`, label: "SF Mono / Menlo" },
  { value: `'Consolas', 'Courier New', ${DEFAULT_MONO_FALLBACK_FONTS}`, label: "Consolas" },
  { value: DEFAULT_MONO_FALLBACK_FONTS, label: "System Monospace" },
];

const LEGACY_MONO_CJK_FALLBACK_FONTS = `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", monospace`;

export const LEGACY_PRESET_FONT_MAP: Record<string, string> = {
  "'Fira Code', 'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', monospace": DEFAULT_MONO_FONT_FAMILY,
  [`'Fira Code', 'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', ${LEGACY_MONO_CJK_FALLBACK_FONTS}`]: DEFAULT_MONO_FONT_FAMILY,
  "'JetBrains Mono', 'Fira Code', monospace": `'JetBrains Mono', 'Fira Code', ${DEFAULT_MONO_FALLBACK_FONTS}`,
  [`'JetBrains Mono', 'Fira Code', ${LEGACY_MONO_CJK_FALLBACK_FONTS}`]: `'JetBrains Mono', 'Fira Code', ${DEFAULT_MONO_FALLBACK_FONTS}`,
  "'Cascadia Code', 'Cascadia Mono', monospace": `'Cascadia Code', 'Cascadia Mono', ${DEFAULT_MONO_FALLBACK_FONTS}`,
  [`'Cascadia Code', 'Cascadia Mono', ${LEGACY_MONO_CJK_FALLBACK_FONTS}`]: `'Cascadia Code', 'Cascadia Mono', ${DEFAULT_MONO_FALLBACK_FONTS}`,
  "'Source Code Pro', monospace": `'Source Code Pro', ${DEFAULT_MONO_FALLBACK_FONTS}`,
  [`'Source Code Pro', ${LEGACY_MONO_CJK_FALLBACK_FONTS}`]: `'Source Code Pro', ${DEFAULT_MONO_FALLBACK_FONTS}`,
  "'SF Mono', 'Menlo', monospace": `'SF Mono', 'Menlo', ${DEFAULT_MONO_FALLBACK_FONTS}`,
  [`'SF Mono', 'Menlo', ${LEGACY_MONO_CJK_FALLBACK_FONTS}`]: `'SF Mono', 'Menlo', ${DEFAULT_MONO_FALLBACK_FONTS}`,
  "'Consolas', 'Courier New', monospace": `'Consolas', 'Courier New', ${DEFAULT_MONO_FALLBACK_FONTS}`,
  [`'Consolas', 'Courier New', ${LEGACY_MONO_CJK_FALLBACK_FONTS}`]: `'Consolas', 'Courier New', ${DEFAULT_MONO_FALLBACK_FONTS}`,
  monospace: DEFAULT_MONO_FALLBACK_FONTS,
  [LEGACY_MONO_CJK_FALLBACK_FONTS]: DEFAULT_MONO_FALLBACK_FONTS,
};

export function cssFontFamilyForName(name: string): string {
  return `'${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}', ${DEFAULT_MONO_FALLBACK_FONTS}`;
}

export function readableFontFamily(value: string): string {
  const firstFamily = value.split(",")[0]?.trim() ?? value;
  return firstFamily.replace(/^['"]|['"]$/g, "").replace(/\\'/g, "'");
}

export function normalizeCustomFontFamilyInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.includes(",") || trimmed.includes("'") || trimmed.includes('"')) return trimmed;
  return cssFontFamilyForName(trimmed);
}
