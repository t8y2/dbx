import { computed, ref } from "vue";
import {
  APP_CORNER_STYLE_STORAGE_KEY,
  APP_THEME_PALETTE_CLASS_NAMES,
  APP_THEME_PALETTE_STORAGE_KEY,
  APP_THEME_STORAGE_KEY,
  getAppThemePaletteClass,
  getTauriThemeForMode,
  isSystemAppThemeMode,
  normalizeAppThemeMode,
  normalizeAppCornerStyle,
  normalizeAppThemePalette,
  resolveAppThemeAppearance,
  type AppThemeMode,
  type AppThemePalette,
  type AppCornerStyle,
} from "@/lib/app/appTheme";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

const savedThemeMode = safeLocalStorageGet(APP_THEME_STORAGE_KEY);
const themeMode = ref<AppThemeMode>(normalizeAppThemeMode(savedThemeMode));
const savedThemePalette = safeLocalStorageGet(APP_THEME_PALETTE_STORAGE_KEY);
const themePalette = ref<AppThemePalette>(normalizeAppThemePalette(savedThemePalette));
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

  // force reflow so the class toggle takes effect before re-enabling transitions
  doc.offsetHeight; // eslint-disable-line @typescript-eslint/no-unused-expressions
  requestAnimationFrame(() => doc.classList.remove("disable-transitions"));

  if (!isTauriRuntime()) return;
  if (cachedTauriWindow) {
    cachedTauriWindow
      .getCurrentWindow()
      .setTheme(getTauriThemeForMode(themeMode.value))
      .catch(() => {});
  } else {
    import("@tauri-apps/api/window").then((mod) => {
      cachedTauriWindow = mod;
      mod
        .getCurrentWindow()
        .setTheme(getTauriThemeForMode(themeMode.value))
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

  return { isDark, themeMode, themePalette, cornerStyle, applyTheme, setThemeMode, setThemePalette, setCornerStyle, toggleTheme };
}
