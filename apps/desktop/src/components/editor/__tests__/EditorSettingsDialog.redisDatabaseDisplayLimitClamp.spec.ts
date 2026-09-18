import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../EditorSettingsDialog.vue", import.meta.url), "utf8");

// Regression found while verifying issue #1236 (Redis sidebar database list
// limit): updateEditorSettings() silently clamps an out-of-range
// redisDatabaseDisplayLimit to [MIN, MAX], but persistSettings() only
// re-synced the dirty-check baseline (editEditorSettingsBase), not the input's
// own v-model ref. Typing a below-minimum value and clicking Apply left the
// draft (the unclamped value) permanently out of sync with the saved
// (clamped) value, so the dialog kept reporting unsaved changes forever after
// a successful apply.
describe("EditorSettingsDialog Redis database display limit clamp resync", () => {
  it("reflects the clamped value back into the input after a successful apply", () => {
    const block = dialogSource.slice(dialogSource.indexOf("async function persistSettings()"), dialogSource.indexOf("function applySettingsErrorToast"));
    expect(block).toContain("editEditorSettingsBase.value = editorSettingsDraftFromSettings(settingsStore.editorSettings);");
    expect(block).toContain("editRedisDatabaseDisplayLimit.value = settingsStore.editorSettings.redisDatabaseDisplayLimit;");
    // The resync must happen after the clamp-and-persist step, inside the same
    // "there is a pending editor-settings patch" branch, not unconditionally.
    const clampResyncIndex = block.indexOf("editRedisDatabaseDisplayLimit.value = settingsStore.editorSettings.redisDatabaseDisplayLimit;");
    const persistIndex = block.indexOf("await settingsStore.persistEditorSettings();");
    expect(clampResyncIndex).toBeGreaterThan(persistIndex);
  });
});
