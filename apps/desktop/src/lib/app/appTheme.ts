import type { Theme } from "@tauri-apps/api/window";

export const APP_THEME_STORAGE_KEY = "dbx-theme";
export const APP_THEME_PALETTE_STORAGE_KEY = "dbx-theme-palette";

export type AppThemeMode = "light" | "dark" | "system";
export type AppThemeAppearance = "light" | "dark";
export type AppThemePalette = "pearl" | "mist" | "graphite" | "cobalt" | "sage" | "amber" | "blush" | "vscode" | "idea" | "xcode" | "jetbrains" | "cursor" | "claude";

export type AppThemePaletteOption = {
  value: AppThemePalette;
  labelKey: string;
  className: string | null;
  previewColor: string;
};

export const APP_THEME_PALETTES: AppThemePaletteOption[] = [
  { value: "pearl", labelKey: "settings.themePalettePearl", className: null, previewColor: "#ffffff" },
  { value: "mist", labelKey: "settings.themePaletteMist", className: "theme-soft", previewColor: "#e4eaf2" },
  { value: "graphite", labelKey: "settings.themePaletteGraphite", className: "theme-graphite", previewColor: "#d8dce4" },
  { value: "cobalt", labelKey: "settings.themePaletteCobalt", className: "theme-cobalt", previewColor: "#d8e6f7" },
  { value: "sage", labelKey: "settings.themePaletteSage", className: "theme-sage", previewColor: "#dbe9e2" },
  { value: "amber", labelKey: "settings.themePaletteAmber", className: "theme-amber", previewColor: "#f4e4b8" },
  { value: "blush", labelKey: "settings.themePaletteBlush", className: "theme-blush", previewColor: "#f4d9e6" },
  { value: "vscode", labelKey: "settings.themePaletteVscode", className: "theme-vscode", previewColor: "#007acc" },
  { value: "idea", labelKey: "settings.themePaletteIdea", className: "theme-idea", previewColor: "#4b6eaf" },
  { value: "xcode", labelKey: "settings.themePaletteXcode", className: "theme-xcode", previewColor: "#0a84ff" },
  { value: "jetbrains", labelKey: "settings.themePaletteJetbrains", className: "theme-jetbrains", previewColor: "#7b61ff" },
  { value: "cursor", labelKey: "settings.themePaletteCursor", className: "theme-cursor", previewColor: "#6ba4ff" },
  { value: "claude", labelKey: "settings.themePaletteClaude", className: "theme-claude", previewColor: "#c47a50" },
];

export const APP_THEME_PALETTE_CLASS_NAMES = APP_THEME_PALETTES.map((palette) => palette.className).filter((className): className is string => Boolean(className));

export function normalizeAppThemeMode(value: string | null): AppThemeMode {
  if (value === "soft-light") return "light";
  if (value === "soft-dark") return "dark";
  if (value === "soft-system") return "system";
  if (value === "dark" || value === "light" || value === "system") return value;
  return "light";
}

export function normalizeAppThemePalette(value: string | null): AppThemePalette {
  if (value === "mist" || value === "graphite" || value === "cobalt" || value === "sage" || value === "amber" || value === "blush" || value === "vscode" || value === "idea" || value === "xcode" || value === "jetbrains" || value === "cursor" || value === "claude" || value === "pearl") return value;
  return "pearl";
}

export function getAppThemePaletteClass(palette: AppThemePalette): string | null {
  return APP_THEME_PALETTES.find((option) => option.value === palette)?.className ?? null;
}

export function isSystemAppThemeMode(mode: AppThemeMode): boolean {
  return mode === "system";
}

export function resolveAppThemeAppearance(mode: AppThemeMode, systemPrefersDark: boolean): AppThemeAppearance {
  if (isSystemAppThemeMode(mode)) return systemPrefersDark ? "dark" : "light";
  return mode === "dark" ? "dark" : "light";
}

export function getTauriThemeForMode(mode: AppThemeMode): Theme | null {
  if (isSystemAppThemeMode(mode)) return null;
  return resolveAppThemeAppearance(mode, false);
}
