// 插件沙箱外观契约与快照工具：PluginAppearance 描述宿主下发的 appearance
// 对象（1.0 部分下发、1.1 theme 通道只带颜色令牌）；buildPluginAppearance
// 组装快照，buildPluginEditorAppearance 产出结构化 editor 字段。实际推送
// 链路在 PluginWorkbenchHost.currentBridgeTheme → PluginHostBridge.updateTheme。

import type { PluginEditorAppearance } from "./pluginHostBridge";

export type { PluginEditorAppearance } from "./pluginHostBridge";

export interface PluginAppearanceColors {
  background: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  border: string;
  destructive: string;
}

export interface PluginAppearance {
  colorScheme: "light" | "dark";
  colors: PluginAppearanceColors;
  // terminal.fontFamily comes from the host's --font-mono token. It is a
  // mirror of the editor font for read-only following; terminal.fontSize is
  // NOT delivered and stays plugin-owned (the SSH terminal, for one, has its
  // own zoom that persists per workbench). The full editor settings — family,
  // size and SQL syntax theme — are delivered structured as `editor`.
  terminal: { fontFamily: string; fontSize: number };
  ui?: { fontFamily: string };
  editor?: PluginEditorAppearance;
}

/** Structured editor appearance for the bridge theme: SQL editor settings that
 * have no CSS-token carrier (the size is a number, the syntax theme an id).
 * Returns undefined unless every field is usable, so snapshots for hosts with
 * incomplete settings stay unchanged instead of carrying partial data. */
export function buildPluginEditorAppearance(editor: { fontFamily?: string; fontSize?: number; theme?: string }): PluginEditorAppearance | undefined {
  const fontFamily = typeof editor.fontFamily === "string" && editor.fontFamily.trim() ? editor.fontFamily : undefined;
  const fontSize = typeof editor.fontSize === "number" && Number.isFinite(editor.fontSize) && editor.fontSize > 0 ? editor.fontSize : undefined;
  const theme = typeof editor.theme === "string" && editor.theme.trim() ? editor.theme : undefined;
  if (!fontFamily || fontSize === undefined || !theme) return undefined;
  return { fontFamily, fontSize, theme };
}

// camelCase 字段 → DBX globals.css 的 CSS 令牌名。
const APPEARANCE_TOKENS = [
  ["background", "--background"],
  ["foreground", "--foreground"],
  ["muted", "--muted"],
  ["mutedForeground", "--muted-foreground"],
  ["accent", "--accent"],
  ["accentForeground", "--accent-foreground"],
  ["border", "--border"],
  ["destructive", "--destructive"],
] as const;

// 读取失败时的兜底：与 DBX globals.css 的 :root（pearl）/.dark 规范块一致。
export const FALLBACK_APPEARANCE_COLORS: Record<"light" | "dark", PluginAppearanceColors> = {
  light: {
    background: "rgb(255 255 255)",
    foreground: "rgb(10 10 10)",
    muted: "rgb(245 245 245)",
    mutedForeground: "rgb(115 115 115)",
    accent: "rgb(245 245 245)",
    accentForeground: "rgb(23 23 23)",
    border: "rgb(229 229 229)",
    destructive: "rgb(231 0 11)",
  },
  dark: {
    background: "rgb(19 20 22)",
    foreground: "rgb(215 215 219)",
    muted: "rgb(42 42 45)",
    mutedForeground: "rgb(151 152 157)",
    accent: "rgb(46 47 51)",
    accentForeground: "rgb(221 221 226)",
    border: "rgb(110 110 114 / 0.28)",
    destructive: "rgb(243 98 95)",
  },
};

export function readAppearanceTokens(): Partial<Record<(typeof APPEARANCE_TOKENS)[number][0], string>> {
  const tokens: Record<string, string> = {};
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return tokens;
  const style = getComputedStyle(document.documentElement);
  for (const [key, cssName] of APPEARANCE_TOKENS) {
    const value = style.getPropertyValue(cssName).trim();
    if (value) tokens[key] = value;
  }
  return tokens;
}

export function buildPluginAppearance(isDark: boolean, tokens: ReturnType<typeof readAppearanceTokens>, terminal: { fontFamily: string; fontSize: number }, uiFontFamily?: string): PluginAppearance {
  const fallback = FALLBACK_APPEARANCE_COLORS[isDark ? "dark" : "light"];
  const colors = { ...fallback };
  for (const [key] of APPEARANCE_TOKENS) {
    const value = tokens[key];
    if (value) colors[key] = value;
  }
  const appearance: PluginAppearance = {
    colorScheme: isDark ? "dark" : "light",
    colors,
    terminal,
  };
  if (uiFontFamily) appearance.ui = { fontFamily: uiFontFamily };
  return appearance;
}
