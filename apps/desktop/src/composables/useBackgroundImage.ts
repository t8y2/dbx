import { computed, ref, watch, watchPostEffect, type ComputedRef, type Ref } from "vue";
import { BACKGROUND_IMAGE_SURFACE_VARS, backgroundImageStyle, backgroundImageSurfaceAlpha, surfaceColorWithAlpha, type BackgroundImageSettings } from "@/lib/app/appBackgroundImage";
import { APP_CUSTOM_UI_COLOR_DEFS, appCustomUiColorValue, deriveCustomUiColors } from "@/lib/app/appTheme";
import { readBackgroundImage } from "@/lib/backend/api";
import { useTheme } from "@/composables/useTheme";
import type { EditorSettings } from "@/stores/settingsStore";

type SettingsStoreLike = { editorSettings: EditorSettings };

export const BACKGROUND_IMAGE_ACTIVE_CLASS = "dbx-bg-active";

const SURFACE_VAR_NAMES = new Set<string>(BACKGROUND_IMAGE_SURFACE_VARS);

const backgroundObjectUrl = ref<string | null>(null);
let loadedFilePath: string | null = null;
let loadEpoch = 0;
let warnedOnce = false;

function base64ToBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes]);
}

async function loadBackgroundObjectUrl(settingsStore: SettingsStoreLike) {
  const filePath = settingsStore.editorSettings.backgroundImage.filePath;
  if (!filePath) {
    loadedFilePath = filePath;
    setAndRevokeObjectUrl(null);
    return;
  }
  const epoch = ++loadEpoch;
  try {
    const base64 = await readBackgroundImage(filePath);
    if (epoch !== loadEpoch) return;
    loadedFilePath = filePath;
    setAndRevokeObjectUrl(URL.createObjectURL(base64ToBlob(base64)));
  } catch (error) {
    if (epoch !== loadEpoch) return;
    loadedFilePath = filePath;
    setAndRevokeObjectUrl(null);
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn("[dbx] failed to load background image; falling back to plain surfaces", error);
    }
  }
}

function setAndRevokeObjectUrl(next: string | null) {
  if (backgroundObjectUrl.value && backgroundObjectUrl.value !== next) {
    URL.revokeObjectURL(backgroundObjectUrl.value);
  }
  backgroundObjectUrl.value = next;
}

export interface BackgroundImageComposable {
  backgroundObjectUrl: Ref<string | null>;
  backgroundSettings: ComputedRef<BackgroundImageSettings>;
  active: ComputedRef<boolean>;
  backgroundImageStyle: ComputedRef<Record<string, string>>;
}

export function useBackgroundImage(settingsStore: SettingsStoreLike): BackgroundImageComposable {
  const backgroundSettings = computed(() => settingsStore.editorSettings.backgroundImage);
  const { isDark, themePalette, activeCustomUiColors, cornerStyle } = useTheme();

  void loadBackgroundObjectUrl(settingsStore);
  watch(
    () => backgroundSettings.value.filePath,
    (filePath) => {
      if (filePath === loadedFilePath) return;
      void loadBackgroundObjectUrl(settingsStore);
    },
  );

  const active = computed(() => Boolean(backgroundObjectUrl.value));

  // Keeps the palette surface colors in sync while the wallpaper is active:
  // clear the inline overrides first so the computed values below come from
  // the freshly applied palette classes, then re-emit them with alpha. The
  // theme refs read below are the reactive deps: any palette / mode / custom
  // color change re-runs this effect right after applyTheme rewrote the
  // class-based (and custom-palette inline) variables. Custom palettes own
  // every surface variable as an inline style, so clearing them would fall
  // back to the palette class colors; their base values are resolved from the
  // custom color settings instead of the computed style.
  const customSurfaceBaseColors = (): Map<string, string> => {
    const base = new Map<string, string>();
    if (themePalette.value !== "custom") return base;
    const colors = activeCustomUiColors.value;
    for (const def of APP_CUSTOM_UI_COLOR_DEFS) {
      if (SURFACE_VAR_NAMES.has(def.varName)) {
        base.set(def.varName, appCustomUiColorValue(colors[def.key]).color);
      }
    }
    for (const [name, value] of Object.entries(deriveCustomUiColors(colors))) {
      if (SURFACE_VAR_NAMES.has(name)) base.set(name, value);
    }
    return base;
  };

  watchPostEffect(() => {
    if (typeof document === "undefined") return;
    void isDark.value;
    void themePalette.value;
    void activeCustomUiColors.value;
    void cornerStyle.value;
    const doc = document.documentElement;
    const alpha = backgroundImageSurfaceAlpha(backgroundSettings.value);
    const isActive = active.value;
    const customBase = customSurfaceBaseColors();
    for (const varName of BACKGROUND_IMAGE_SURFACE_VARS) {
      doc.style.removeProperty(varName);
    }
    doc.classList.toggle(BACKGROUND_IMAGE_ACTIVE_CLASS, isActive);
    if (!isActive) {
      // Re-emit the custom palette values the clear above removed.
      for (const [varName, color] of customBase) {
        doc.style.setProperty(varName, color);
      }
      return;
    }
    const computedStyle = getComputedStyle(doc);
    for (const varName of BACKGROUND_IMAGE_SURFACE_VARS) {
      const base = customBase.get(varName) ?? computedStyle.getPropertyValue(varName);
      const tinted = surfaceColorWithAlpha(base, alpha);
      if (tinted) doc.style.setProperty(varName, tinted);
    }
  });

  return {
    backgroundObjectUrl,
    backgroundSettings,
    active,
    backgroundImageStyle: computed(() => backgroundImageStyle(backgroundSettings.value, backgroundObjectUrl.value)),
  };
}
