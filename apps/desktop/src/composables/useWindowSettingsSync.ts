import { onMounted, onUnmounted } from "vue";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useSettingsStore, type EditorSettings, type DesktopSettings } from "@/stores/settingsStore";
import { setLocalAppearance, type AppAppearanceSettingsPatch } from "@/lib/app/appAppearance";
import { applySharedTheme } from "@/composables/useTheme";
import { applySharedLocale } from "@/i18n";

export function useWindowSettingsSync() {
  const settings = useSettingsStore();
  let disposed = false;
  const handles: (() => void)[] = [];
  onMounted(async () => {
    if (!isTauriRuntime()) return;
    const { listen } = await import("@tauri-apps/api/event");
    const register = async <T>(event: string, apply: (payload: T) => void | Promise<void>) => {
      const unlisten = await listen<T>(event, ({ payload }) => {
        if (!disposed) void apply(payload);
      });
      if (disposed) unlisten();
      else handles.push(unlisten);
    };
    await Promise.all([
      register<Partial<EditorSettings>>("dbx:editor-settings-changed", (payload) => settings.applySharedEditorSettings(payload)),
      register<DesktopSettings>("dbx:desktop-settings-changed", (payload) => settings.applySharedDesktopSettings(payload)),
      register<AppAppearanceSettingsPatch>("dbx:appearance-changed", async (patch) => {
        setLocalAppearance(patch);
        applySharedTheme(patch);
        if (patch.locale) await applySharedLocale(patch.locale);
      }),
    ]);
  });
  onUnmounted(() => {
    disposed = true;
    handles.forEach((unlisten) => unlisten());
  });
}
