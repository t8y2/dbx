import { EDITOR_FONT_FAMILY_CSS_VAR, EDITOR_FONT_SIZE_CSS_VAR } from "@/lib/editorThemes";
import type { EditorSettings } from "@/stores/settingsStore";

export type DocumentViewerFontSettings = Pick<EditorSettings, "fontFamily" | "fontSize">;

export function documentViewerFontStyle(settings: DocumentViewerFontSettings): Record<string, string> {
  return {
    [EDITOR_FONT_FAMILY_CSS_VAR]: settings.fontFamily,
    [EDITOR_FONT_SIZE_CSS_VAR]: `${settings.fontSize}px`,
  };
}
