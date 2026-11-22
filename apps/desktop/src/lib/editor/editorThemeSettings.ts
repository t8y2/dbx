import { customUiAppearance, type AppCustomUiColors, type AppThemeAppearance, type AppThemePalette } from "@/lib/app/appTheme";
import type { EditorSettings } from "@/stores/settingsStore";

export function resolveEditorThemeColors(settings: Pick<EditorSettings, "theme" | "customThemes" | "activeCustomThemeId" | "customThemeColors">) {
  if (settings.theme !== "custom") return settings.customThemeColors;
  const themes = settings.customThemes;
  const activeTheme = themes?.find((theme) => theme.id === settings.activeCustomThemeId) ?? themes?.[0];
  return activeTheme?.colors ?? settings.customThemeColors;
}

/**
 * Effective appearance for the "Follow app theme" editor: with the custom UI
 * palette the mode's light/dark flag is replaced by the custom background's
 * luminance, keeping tokens, selection, cursor, search matches and diagnostics
 * readable on arbitrarily dark/light custom backgrounds. Other palettes keep
 * the previous appearance unchanged.
 */
export function editorThemeAppearanceFor(appAppearance: AppThemeAppearance, appPalette: AppThemePalette, customUiColors?: AppCustomUiColors): AppThemeAppearance {
  if (appPalette === "custom" && customUiColors) return customUiAppearance(customUiColors);
  return appAppearance;
}
