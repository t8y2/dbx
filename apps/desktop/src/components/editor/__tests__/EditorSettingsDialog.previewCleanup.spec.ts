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
    expect(dialogSource).toContain("restoreLocaleOptionPreview();");
  });

  it("coalesces pointer previews while keeping keyboard previews immediate", () => {
    expect(dialogSource).toContain('@update:open="onLocaleOpenChange"');
    expect(dialogSource).toContain('@pointerleave="restoreLocaleOptionPreview"');
    expect(dialogSource).toContain('@pointerenter="scheduleLocaleOptionPreview(locale.value)"');
    expect(dialogSource).toContain('@focus="previewLocaleOption(locale.value)"');
    expect(dialogSource).toContain('@pointerenter="scheduleThemePalettePreview(option.value)"');
    expect(dialogSource).toContain('@focus="previewThemePaletteOption(option.value)"');
    expect(dialogSource).toContain('@option-hover="scheduleUiFontOptionPreview"');
    expect(dialogSource).toContain('@option-highlight="previewUiFontOption"');
    expect(dialogSource).toContain("createDelayedPreview");
  });

  it("keeps scale as an unapplied draft", () => {
    expect(dialogSource).toContain('@update:model-value="onUiScaleChange"');
    expect(dialogSource).not.toContain("useUiScalePreview");
    expect(dialogSource).not.toContain("previewUiScaleOption");
    expect(dialogSource).not.toContain("createUiScalePreviewRestore");
    expect(appSource).toContain("createUiScaleApplyQueue");
    expect(appSource).not.toContain("useUiScalePreview");
    expect(appSource).toContain("() => settingsStore.editorSettings.uiScale");
    expect(appSource).toContain("applyUiScale(scale)");
  });
});
