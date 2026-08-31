import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settingsDialogSource = readFileSync(new URL("../../../components/editor/EditorSettingsDialog.vue", import.meta.url), "utf8");

describe("openDataTabsNextToActive settings control", () => {
  it("binds the navigation switch through apply and both reset paths", () => {
    expect(settingsDialogSource).toContain("const editOpenDataTabsNextToActive = ref(settingsStore.editorSettings.openDataTabsNextToActive)");
    expect(settingsDialogSource).toContain("openDataTabsNextToActive: editOpenDataTabsNextToActive.value");
    expect(settingsDialogSource.match(/editOpenDataTabsNextToActive\.value = DEFAULT_EDITOR_SETTINGS\.openDataTabsNextToActive/g)).toHaveLength(2);
    expect(settingsDialogSource).toContain('id="open-data-tabs-next-to-active" v-model="editOpenDataTabsNextToActive"');
  });
});
