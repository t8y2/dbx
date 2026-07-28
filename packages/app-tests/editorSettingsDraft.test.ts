import assert from "node:assert/strict";
import { test } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { DEFAULT_UI_FONT_FAMILY } from "../../apps/desktop/src/lib/app/appFonts.ts";
import { editorSettingsDraftFromSettings, editorSettingsPatchFromDraft } from "../../apps/desktop/src/lib/settings/editorSettingsDraft.ts";
import { DEFAULT_EDITOR_SETTINGS, useSettingsStore } from "../../apps/desktop/src/stores/settingsStore.ts";

test("keeps a loaded editor font when an old appearance draft only changes the UI font", () => {
  setActivePinia(createPinia());
  const store = useSettingsStore();
  const savedEditorFont = "'Cascadia Code', 'Cascadia Mono', monospace";

  store.updateEditorSettings({ fontFamily: savedEditorFont });

  const staleDraftBase = editorSettingsDraftFromSettings(DEFAULT_EDITOR_SETTINGS);
  const staleDraft = {
    ...staleDraftBase,
    uiFontFamily: `"Aptos", ${DEFAULT_UI_FONT_FAMILY}`,
  };

  const patch = editorSettingsPatchFromDraft(staleDraft, staleDraftBase);
  store.updateEditorSettings(patch);

  assert.equal(patch.fontFamily, undefined);
  assert.equal(store.editorSettings.fontFamily, savedEditorFont);
  assert.equal(store.editorSettings.uiFontFamily, staleDraft.uiFontFamily);
});

test("applies a result grid font without overwriting editor or interface fonts", () => {
  setActivePinia(createPinia());
  const store = useSettingsStore();
  const draftBase = editorSettingsDraftFromSettings(store.editorSettings);
  const tableFontFamily = `"IBM Plex Mono", monospace`;
  const patch = editorSettingsPatchFromDraft({ ...draftBase, tableFontFamily }, draftBase);

  store.updateEditorSettings(patch);

  assert.equal(patch.fontFamily, undefined);
  assert.equal(patch.uiFontFamily, undefined);
  assert.equal(patch.tableFontFamily, tableFontFamily);
  assert.equal(store.editorSettings.tableFontFamily, tableFontFamily);
});
