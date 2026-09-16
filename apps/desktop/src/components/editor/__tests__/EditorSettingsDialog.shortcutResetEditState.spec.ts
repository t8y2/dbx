import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../EditorSettingsDialog.vue", import.meta.url), "utf8");

// Regression for https://github.com/t8y2/dbx/issues/9066: clicking a shortcut
// row's edit button enters the per-row capture state (editingShortcutId), and
// clicking the footer "restore defaults" button afterwards reset the shortcut
// values but left the row stuck in the editing state ("press shortcut"
// capture input still active). Restoring defaults must also exit the edit
// mode so the row returns to its initial pill display. The clear happens at
// the top of both reset entrypoints because the edit state can leak across
// tab switches (the shortcuts and formatter tables share it).
describe("EditorSettingsDialog shortcut restore-defaults exits edit state", () => {
  it("resetDefaultsForTab clears the in-progress shortcut capture before resetting values", () => {
    const head = dialogSource.slice(dialogSource.indexOf("function resetDefaultsForTab(tab: SettingsCategory) {"), dialogSource.indexOf('if (tab === "editor") {'));
    expect(head).toContain("editingShortcutId.value = null;");
  });

  it("resetAllDefaults clears the in-progress shortcut capture too", () => {
    const start = dialogSource.indexOf("function resetAllDefaults() {");
    const head = dialogSource.slice(start, dialogSource.indexOf("editFontFamily.value = DEFAULT_EDITOR_SETTINGS.fontFamily;", start));
    expect(head).toContain("editingShortcutId.value = null;");
  });

  it("keeps the footer restore-defaults button wired to resetDefaultsForTab", () => {
    expect(dialogSource).toContain('@click="resetDefaultsForTab(activeSettingsTab as SettingsCategory)"');
    expect(dialogSource).toContain('{{ t("settings.resetDefaults") }}');
  });
});
