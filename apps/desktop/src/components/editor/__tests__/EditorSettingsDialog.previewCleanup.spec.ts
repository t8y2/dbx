import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../EditorSettingsDialog.vue", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");

describe("EditorSettingsDialog preview cleanup", () => {
  it("keeps the existing draft lifecycle independent from page activity", () => {
    expect(dialogSource).toContain("const settingsVisible = computed(() => isSettingsPage.value || props.open === true);");
    expect(dialogSource).toContain("syncEditorSettingsDraftFromStore();");
  });

  it("clears previews when a mounted settings page becomes inactive", () => {
    expect(appSource).toContain('v-if="settingsPageTabOpen"');
    expect(appSource).toContain('v-show="settingsStore.settingsPageActive"');
    expect(dialogSource).toContain("() => settingsStore.settingsPageActive");
    expect(dialogSource).toContain("if (isSettingsPage.value && !active)");
    expect(dialogSource).toContain("clearThemePalettePreview();");
    expect(dialogSource).toContain("clearUiFontFamilyPreview();");
  });
});
