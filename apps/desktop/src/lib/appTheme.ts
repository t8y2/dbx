import type { Theme } from "@tauri-apps/api/window";

export const APP_THEME_STORAGE_KEY = "dbx-theme";

export type AppThemeMode = "light" | "dark" | "system";
export type AppThemeAppearance = "light" | "dark";

export function normalizeAppThemeMode(value: string | null): AppThemeMode {
  if (value === "dark" || value === "light" || value === "system") return value;
  return "light";
}

export function resolveAppThemeAppearance(mode: AppThemeMode, systemPrefersDark: boolean): AppThemeAppearance {
  if (mode === "system") return systemPrefersDark ? "dark" : "light";
  return mode;
}

export function getTauriThemeForMode(mode: AppThemeMode): Theme | null {
  return mode === "system" ? null : mode;
}
