// 插件沙箱外观快照：读取 DBX 根节点的设计令牌（随 .dark / 调色板类
// 实时变化）加编辑器字体设置，组装成插件契约里的 appearance 对象，
// 供 PluginHostBridge 在 init 下发、主题变化时实时推送。

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
  terminal: { fontFamily: string; fontSize: number };
  ui?: { fontFamily: string };
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
