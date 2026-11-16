import { computed, onScopeDispose, ref, watch, watchPostEffect, type ComputedRef, type Ref } from "vue";
import { BACKGROUND_IMAGE_INVERTED_TEXT_VARS, BACKGROUND_IMAGE_SURFACE_VARS, backgroundImageSolidVarName, backgroundImageStyle, backgroundImageSurfaceAlpha, surfaceColorWithAlpha, type BackgroundImageSettings } from "@/lib/app/appBackgroundImage";
import { APP_CUSTOM_UI_COLOR_DEFS, appCustomUiColorValue, deriveCustomUiColors } from "@/lib/app/appTheme";
import { readBackgroundImage } from "@/lib/backend/api";
import { useTheme } from "@/composables/useTheme";
import type { EditorSettings } from "@/stores/settingsStore";

type SettingsStoreLike = { editorSettings: EditorSettings };

export const BACKGROUND_IMAGE_ACTIVE_CLASS = "dbx-bg-active";

const SURFACE_VAR_NAMES = new Set<string>(BACKGROUND_IMAGE_SURFACE_VARS);

function base64ToBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes]);
}

export interface BackgroundImageComposable {
  backgroundObjectUrl: Ref<string | null>;
  backgroundSettings: ComputedRef<BackgroundImageSettings>;
  active: ComputedRef<boolean>;
  backgroundImageStyle: ComputedRef<Record<string, string>>;
}

export function useBackgroundImage(settingsStore: SettingsStoreLike): BackgroundImageComposable {
  const backgroundObjectUrl = ref<string | null>(null);
  let warnedOnce = false;
  const backgroundSettings = computed(() => settingsStore.editorSettings.backgroundImage);
  const { isDark, themePalette, activeCustomUiColors, cornerStyle, themeRevision } = useTheme();

  function setAndRevokeObjectUrl(next: string | null) {
    if (backgroundObjectUrl.value && backgroundObjectUrl.value !== next) {
      URL.revokeObjectURL(backgroundObjectUrl.value);
    }
    backgroundObjectUrl.value = next;
  }

  watch(
    () => backgroundSettings.value.filePath,
    async (filePath, _previous, onCleanup) => {
      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
        setAndRevokeObjectUrl(null);
      });
      if (!filePath) return;
      try {
        const base64 = await readBackgroundImage(filePath);
        if (cancelled) return;
        setAndRevokeObjectUrl(URL.createObjectURL(base64ToBlob(base64)));
      } catch (error) {
        if (cancelled) return;
        setAndRevokeObjectUrl(null);
        if (!warnedOnce) {
          warnedOnce = true;
          console.warn("[dbx] failed to load background image; falling back to plain surfaces", error);
        }
      }
    },
    { immediate: true, flush: "sync" },
  );

  const active = computed(() => Boolean(backgroundObjectUrl.value));

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

  const resetSurfaceColors = () => {
    const doc = document.documentElement;
    const customBase = customSurfaceBaseColors();
    for (const varName of [...BACKGROUND_IMAGE_SURFACE_VARS, ...BACKGROUND_IMAGE_INVERTED_TEXT_VARS.map(backgroundImageSolidVarName)]) {
      doc.style.removeProperty(varName);
    }
    for (const [varName, color] of customBase) {
      doc.style.setProperty(varName, color);
    }
    doc.classList.remove(BACKGROUND_IMAGE_ACTIVE_CLASS);
    return customBase;
  };

  onScopeDispose(() => {
    if (typeof document !== "undefined") resetSurfaceColors();
  });

  watchPostEffect(() => {
    if (typeof document === "undefined") return;
    void isDark.value;
    void themePalette.value;
    void activeCustomUiColors.value;
    void cornerStyle.value;
    void themeRevision.value;
    const doc = document.documentElement;
    const alpha = backgroundImageSurfaceAlpha(backgroundSettings.value);
    const isActive = active.value;
    const customBase = resetSurfaceColors();
    doc.classList.toggle(BACKGROUND_IMAGE_ACTIVE_CLASS, isActive);
    if (!isActive) return;
    const computedStyle = getComputedStyle(doc);
    const baseColors = new Map([...BACKGROUND_IMAGE_SURFACE_VARS, ...BACKGROUND_IMAGE_INVERTED_TEXT_VARS].map((varName) => [varName, (customBase.get(varName) ?? computedStyle.getPropertyValue(varName)).trim()]));
    for (const varName of BACKGROUND_IMAGE_SURFACE_VARS) {
      const base = baseColors.get(varName)!;
      const tinted = surfaceColorWithAlpha(base, alpha);
      if (tinted) doc.style.setProperty(varName, tinted);
    }
    for (const varName of BACKGROUND_IMAGE_INVERTED_TEXT_VARS) {
      const base = baseColors.get(varName)!;
      if (base) doc.style.setProperty(backgroundImageSolidVarName(varName), base);
    }
  });

  return {
    backgroundObjectUrl,
    backgroundSettings,
    active,
    backgroundImageStyle: computed(() => backgroundImageStyle(backgroundSettings.value, backgroundObjectUrl.value)),
  };
}
