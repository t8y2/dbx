import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { APP_CORNER_STYLE_STORAGE_KEY, APP_CUSTOM_UI_DARK_STORAGE_KEY, APP_CUSTOM_UI_STORAGE_KEY, APP_THEME_PALETTE_STORAGE_KEY, APP_THEME_STORAGE_KEY, type AppCustomUiColors, type AppCornerStyle, type AppThemeMode, type AppThemePalette } from "@/lib/app/appTheme";

export interface AppAppearanceSettings {
  locale?: string | null;
  themeMode?: AppThemeMode | string | null;
  themePalette?: AppThemePalette | string | null;
  customUiColors?: AppCustomUiColors | null;
  customUiColorsDark?: AppCustomUiColors | null;
  cornerStyle?: AppCornerStyle | string | null;
}

export type AppAppearanceSettingsPatch = Partial<AppAppearanceSettings>;

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

let hydrationPromise: Promise<void> | null = null;
let persistenceQueue: Promise<void> = Promise.resolve();

function warn(action: string, error: unknown) {
  console.warn(`[DBX][appearance:${action}]`, error);
}

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = (await import("@tauri-apps/api/core")) as { invoke: TauriInvoke };
  return invoke<T>(command, args);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validThemeMode(value: unknown): value is AppThemeMode {
  return value === "light" || value === "dark" || value === "system" || value === "soft-light" || value === "soft-dark" || value === "soft-system";
}

function validThemePalette(value: unknown): value is AppThemePalette {
  return (
    value === "pearl" ||
    value === "mist" ||
    value === "graphite" ||
    value === "cobalt" ||
    value === "sage" ||
    value === "amber" ||
    value === "blush" ||
    value === "vscode" ||
    value === "idea" ||
    value === "xcode" ||
    value === "jetbrains" ||
    value === "cursor" ||
    value === "claude" ||
    value === "custom"
  );
}

function validCornerStyle(value: unknown): value is AppCornerStyle {
  return value === "none" || value === "small" || value === "large";
}

function parseColorObject(raw: string | null): AppCustomUiColors | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as AppCustomUiColors) : undefined;
  } catch {
    return undefined;
  }
}

function localAppearance(): AppAppearanceSettings {
  return {
    locale: safeLocalStorageGet("dbx-locale"),
    themeMode: safeLocalStorageGet(APP_THEME_STORAGE_KEY),
    themePalette: safeLocalStorageGet(APP_THEME_PALETTE_STORAGE_KEY),
    customUiColors: parseColorObject(safeLocalStorageGet(APP_CUSTOM_UI_STORAGE_KEY)),
    customUiColorsDark: parseColorObject(safeLocalStorageGet(APP_CUSTOM_UI_DARK_STORAGE_KEY)),
    cornerStyle: safeLocalStorageGet(APP_CORNER_STYLE_STORAGE_KEY),
  };
}

function backendField<T>(settings: Record<string, unknown>, camelCase: string, snakeCase: string): T | undefined {
  const value = settings[camelCase] ?? settings[snakeCase];
  return value as T | undefined;
}

function setLocalAppearance(patch: AppAppearanceSettingsPatch) {
  if (nonEmptyString(patch.locale)) safeLocalStorageSet("dbx-locale", patch.locale);
  if (validThemeMode(patch.themeMode)) safeLocalStorageSet(APP_THEME_STORAGE_KEY, patch.themeMode);
  if (validThemePalette(patch.themePalette)) safeLocalStorageSet(APP_THEME_PALETTE_STORAGE_KEY, patch.themePalette);
  if (patch.customUiColors && typeof patch.customUiColors === "object") {
    safeLocalStorageSet(APP_CUSTOM_UI_STORAGE_KEY, JSON.stringify(patch.customUiColors));
  }
  if (patch.customUiColorsDark && typeof patch.customUiColorsDark === "object") {
    safeLocalStorageSet(APP_CUSTOM_UI_DARK_STORAGE_KEY, JSON.stringify(patch.customUiColorsDark));
  }
  if (validCornerStyle(patch.cornerStyle)) safeLocalStorageSet(APP_CORNER_STYLE_STORAGE_KEY, patch.cornerStyle);
}

function enqueuePersistence(operation: () => Promise<void>, action: string) {
  persistenceQueue = persistenceQueue
    .catch(() => {})
    .then(operation)
    .catch((error) => warn(action, error));
}

/**
 * Hydrate the renderer's legacy storage keys from the durable Tauri app
 * settings record before i18n and the theme composable are imported. Backend
 * values win; existing localStorage values are migrated when a field is new.
 */
export async function hydrateAppAppearance(): Promise<void> {
  if (!isTauriRuntime()) return;
  if (!hydrationPromise) {
    hydrationPromise = (async () => {
      let raw: unknown;
      try {
        raw = await invokeTauri("load_app_appearance_settings");
      } catch (error) {
        warn("load", error);
        return;
      }
      const backend = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      const local = localAppearance();
      const migrate: AppAppearanceSettingsPatch = {};

      const locale = backendField<string>(backend, "locale", "locale");
      if (nonEmptyString(locale)) setLocalAppearance({ locale });
      else if (nonEmptyString(local.locale)) migrate.locale = local.locale;

      const themeMode = backendField<string>(backend, "themeMode", "theme_mode");
      if (validThemeMode(themeMode)) setLocalAppearance({ themeMode });
      else if (validThemeMode(local.themeMode)) migrate.themeMode = local.themeMode;

      const themePalette = backendField<string>(backend, "themePalette", "theme_palette");
      if (validThemePalette(themePalette)) setLocalAppearance({ themePalette });
      else if (validThemePalette(local.themePalette)) migrate.themePalette = local.themePalette;

      const customUiColors = backendField<AppCustomUiColors>(backend, "customUiColors", "custom_ui_colors");
      if (customUiColors && typeof customUiColors === "object" && !Array.isArray(customUiColors)) setLocalAppearance({ customUiColors });
      else if (local.customUiColors) migrate.customUiColors = local.customUiColors;

      const customUiColorsDark = backendField<AppCustomUiColors>(backend, "customUiColorsDark", "custom_ui_colors_dark");
      if (customUiColorsDark && typeof customUiColorsDark === "object" && !Array.isArray(customUiColorsDark)) setLocalAppearance({ customUiColorsDark });
      else if (local.customUiColorsDark) migrate.customUiColorsDark = local.customUiColorsDark;

      const cornerStyle = backendField<string>(backend, "cornerStyle", "corner_style");
      if (validCornerStyle(cornerStyle)) setLocalAppearance({ cornerStyle });
      else if (validCornerStyle(local.cornerStyle)) migrate.cornerStyle = local.cornerStyle;

      if (Object.keys(migrate).length > 0) {
        try {
          await invokeTauri("update_app_appearance_settings", { patch: migrate });
        } catch (error) {
          warn("migrate", error);
        }
      }
    })().finally(() => {
      hydrationPromise = null;
    });
  }
  await hydrationPromise;
}

export function persistAppAppearancePatch(patch: AppAppearanceSettingsPatch) {
  setLocalAppearance(patch);
  if (!isTauriRuntime()) return;
  enqueuePersistence(() => invokeTauri("update_app_appearance_settings", { patch }), "save");
}

export function persistAppLocale(locale: string) {
  setLocalAppearance({ locale });
  if (!isTauriRuntime()) return;
  enqueuePersistence(() => invokeTauri("set_app_locale", { locale }), "locale");
}
