import { describe, expect, it } from "vitest";
import { SETTINGS_SEARCH_DEFINITIONS } from "@/lib/settings/settingsSearch";
import dialogSource from "../EditorSettingsDialog.vue?raw";

describe("EditorSettingsDialog AI typography settings", () => {
  it("exposes the family and size controls through settings search", () => {
    const definitions = SETTINGS_SEARCH_DEFINITIONS.filter((definition) => definition.id.startsWith("ai-conversation-font-"));

    expect(definitions).toEqual([expect.objectContaining({ id: "ai-conversation-font-family", category: "ai", targetId: "ai-typography" }), expect.objectContaining({ id: "ai-conversation-font-size", category: "ai", targetId: "ai-typography" })]);
    expect(dialogSource).toContain('data-settings-search-id="ai-typography"');
    expect(dialogSource).toContain('id="ai-conversation-font-size"');
  });

  it("persists each control immediately and offers a dedicated reset", () => {
    expect(dialogSource).toContain('@update:model-value="onAiFontFamilyChange"');
    expect(dialogSource).toContain('@change="commitAiFontSize"');
    expect(dialogSource).toContain('@click="resetAiTypography"');
    expect(dialogSource).toContain("settingsStore.updateEditorSettingsAndPersist(partial)");
  });

  it("keeps system and custom conversation fonts independent from editor fallbacks", () => {
    expect(dialogSource).toContain("systemFonts.value.map(aiConversationFontFamilyForName)");
    expect(dialogSource).toContain(':normalize-custom="normalizeAiConversationFontFamilyInput"');
  });
});
