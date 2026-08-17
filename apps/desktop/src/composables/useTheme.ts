import { computed, ref } from "vue";
import {
  APP_CORNER_STYLE_STORAGE_KEY,
  APP_CUSTOM_UI_COLOR_DEFS,
  APP_CUSTOM_UI_DARK_STORAGE_KEY,
  APP_CUSTOM_UI_DERIVED_VAR_NAMES,
  APP_CUSTOM_UI_STORAGE_KEY,
  deriveCustomUiColors,
  APP_THEME_PALETTE_CLASS_NAMES,
  APP_THEME_PALETTE_STORAGE_KEY,
  APP_THEME_STORAGE_KEY,
  DEFAULT_APP_CUSTOM_UI_COLORS,
  DEFAULT_APP_CUSTOM_UI_COLORS_DARK,
  appCustomUiColorValue,
  getAppThemePaletteClass,
  getTauriThemeForMode,
  isSystemAppThemeMode,
  normalizeAppCustomUiColors,
  normalizeAppThemeMode,
  normalizeAppCornerStyle,
  normalizeAppThemePalette,
  resolveAppThemeAppearance,
  type AppCustomUiColors,
  type AppThemeMode,
  type AppThemePalette,
  type AppCornerStyle,
} from "@/lib/app/appTheme";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

function isLinuxTauriRuntime() {
  return isTauriRuntime() && typeof navigator !== "undefined" && /linux/i.test(navigator.userAgent);
}

const savedThemeMode = safeLocalStorageGet(APP_THEME_STORAGE_KEY);
const themeMode = ref<AppThemeMode>(normalizeAppThemeMode(savedThemeMode));
const savedThemePalette = safeLocalStorageGet(APP_THEME_PALETTE_STORAGE_KEY);
const themePalette = ref<AppThemePalette>(normalizeAppThemePalette(savedThemePalette));
function parseStoredCustomUiColors(raw: string | null): AppCustomUiColors | null {
  if (!raw) return null;
  try {
    return normalizeAppCustomUiColors(JSON.parse(raw));
  } catch {
    return null;
  }
}
const customUiColors = ref<AppCustomUiColors>(parseStoredCustomUiColors(safeLocalStorageGet(APP_CUSTOM_UI_STORAGE_KEY)) ?? DEFAULT_APP_CUSTOM_UI_COLORS);
const customUiColorsDark = ref<AppCustomUiColors>(parseStoredCustomUiColors(safeLocalStorageGet(APP_CUSTOM_UI_DARK_STORAGE_KEY)) ?? DEFAULT_APP_CUSTOM_UI_COLORS_DARK);
const activeCustomUiColors = computed<AppCustomUiColors>(() => (isDark.value ? customUiColorsDark.value : customUiColors.value));
const savedCornerStyle = safeLocalStorageGet(APP_CORNER_STYLE_STORAGE_KEY);
const cornerStyle = ref<AppCornerStyle>(normalizeAppCornerStyle(savedCornerStyle));
if (savedThemeMode && savedThemeMode !== themeMode.value) safeLocalStorageSet(APP_THEME_STORAGE_KEY, themeMode.value);
if (savedCornerStyle && savedCornerStyle !== cornerStyle.value) safeLocalStorageSet(APP_CORNER_STYLE_STORAGE_KEY, cornerStyle.value);
const systemPrefersDark = ref(readSystemPrefersDark());
const isDark = computed(() => resolveAppThemeAppearance(themeMode.value, systemPrefersDark.value) === "dark");

let mediaQuery: MediaQueryList | null = null;
let isListeningForSystemTheme = false;
let cachedTauriWindow: typeof import("@tauri-apps/api/window") | null = null;

function readSystemPrefersDark() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function setupSystemThemeListener() {
  if (isListeningForSystemTheme || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  systemPrefersDark.value = mediaQuery.matches;
  const onChange = (event: MediaQueryListEvent) => {
    systemPrefersDark.value = event.matches;
    if (isSystemAppThemeMode(themeMode.value)) applyTheme();
  };
  mediaQuery.addEventListener("change", onChange);
  isListeningForSystemTheme = true;
}

function applyTheme() {
  if (typeof document === "undefined") return;

  const doc = document.documentElement;
  const dark = isDark.value;

  doc.classList.add("disable-transitions");
  doc.classList.toggle("dark", dark);
  for (const className of APP_THEME_PALETTE_CLASS_NAMES) doc.classList.remove(className);
  const paletteClass = getAppThemePaletteClass(themePalette.value);
  if (paletteClass) doc.classList.add(paletteClass);
  doc.dataset.cornerStyle = cornerStyle.value;
  doc.style.colorScheme = dark ? "dark" : "light";
  applyCustomUiColors();

  // force reflow so the class toggle takes effect before re-enabling transitions
  doc.offsetHeight; // eslint-disable-line @typescript-eslint/no-unused-expressions
  requestAnimationFrame(() => doc.classList.remove("disable-transitions"));
  if (!isTauriRuntime()) return;

  const tauriTheme = getTauriThemeForMode(themeMode.value);
  // Tauri owns the Linux GTK preference. Calling setTheme(null) here forces it
  // to light, so only skip the native system-theme write and keep explicit modes.
  if (isLinuxTauriRuntime() && tauriTheme == null) return;

  if (cachedTauriWindow) {
    cachedTauriWindow
      .getCurrentWindow()
      .setTheme(tauriTheme)
      .catch(() => {});
  } else {
    import("@tauri-apps/api/window").then((mod) => {
      cachedTauriWindow = mod;
      mod
        .getCurrentWindow()
        .setTheme(tauriTheme)
        .catch(() => {});
    });
  }
}

function setThemeMode(mode: AppThemeMode) {
  themeMode.value = mode;
  safeLocalStorageSet(APP_THEME_STORAGE_KEY, mode);
  applyTheme();
}

function setThemePalette(palette: AppThemePalette) {
  themePalette.value = palette;
  safeLocalStorageSet(APP_THEME_PALETTE_STORAGE_KEY, palette);
  applyTheme();
}

function applyCustomUiColors() {
  if (typeof document === "undefined") return;
  const doc = document.documentElement;
  const clear = () => {
    for (const def of APP_CUSTOM_UI_COLOR_DEFS) {
      doc.style.removeProperty(def.varName);
      if (def.rgbVarName) doc.style.removeProperty(def.rgbVarName);
    }
    for (const name of APP_CUSTOM_UI_DERIVED_VAR_NAMES) doc.style.removeProperty(name);
  };
  if (themePalette.value !== "custom") {
    clear();
    return;
  }
  for (const def of APP_CUSTOM_UI_COLOR_DEFS) {
    const { color, rgbTriplet } = appCustomUiColorValue(activeCustomUiColors.value[def.key]);
    doc.style.setProperty(def.varName, color);
    if (def.rgbVarName) doc.style.setProperty(def.rgbVarName, rgbTriplet);
  }
  const derived = deriveCustomUiColors(activeCustomUiColors.value);
  for (const name of APP_CUSTOM_UI_DERIVED_VAR_NAMES) doc.style.setProperty(name, derived[name]);
}

function setCustomUiColors(colors: AppCustomUiColors) {
  const next = normalizeAppCustomUiColors(colors);
  if (isDark.value) {
    customUiColorsDark.value = next;
    safeLocalStorageSet(APP_CUSTOM_UI_DARK_STORAGE_KEY, JSON.stringify(next));
  } else {
    customUiColors.value = next;
    safeLocalStorageSet(APP_CUSTOM_UI_STORAGE_KEY, JSON.stringify(next));
  }
  applyCustomUiColors();
}

function resetCustomUiColors() {
  setCustomUiColors({ ...(isDark.value ? DEFAULT_APP_CUSTOM_UI_COLORS_DARK : DEFAULT_APP_CUSTOM_UI_COLORS) });
}

function setCornerStyle(style: AppCornerStyle) {
  cornerStyle.value = normalizeAppCornerStyle(style);
  safeLocalStorageSet(APP_CORNER_STYLE_STORAGE_KEY, cornerStyle.value);
  applyTheme();
}

export function useTheme() {
  setupSystemThemeListener();

  function toggleTheme() {
    setThemeMode(isDark.value ? "light" : "dark");
  }

  return { isDark, themeMode, themePalette, customUiColors, customUiColorsDark, activeCustomUiColors, cornerStyle, applyTheme, setThemeMode, setThemePalette, setCustomUiColors, resetCustomUiColors, setCornerStyle, toggleTheme };
}
