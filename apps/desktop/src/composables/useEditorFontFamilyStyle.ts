import { computed } from "vue";
import { EDITOR_FONT_FAMILY_CSS_VAR } from "@/lib/editorThemes";
import { useSettingsStore } from "@/stores/settingsStore";

export function useEditorFontFamilyStyle() {
  const settingsStore = useSettingsStore();

  return computed<Record<string, string>>(() => ({
    [EDITOR_FONT_FAMILY_CSS_VAR]: settingsStore.editorSettings.fontFamily,
  }));
}
