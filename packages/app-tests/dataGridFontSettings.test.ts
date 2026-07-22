import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const dataGridSource = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
const settingsDialogSource = readFileSync("apps/desktop/src/components/editor/EditorSettingsDialog.vue", "utf8");
const quickControlSource = readFileSync("apps/desktop/src/components/grid/DataGridFontFamilyControl.vue", "utf8");

test("applies the configured result grid font to DOM and canvas renderers", () => {
  assert.match(dataGridSource, /const tableFontFamily = computed\(\(\) => settingsStore\.editorSettings\.tableFontFamily\)/);
  assert.match(dataGridSource, /"--dbx-data-grid-font-family": tableFontFamily\.value/);
  assert.match(dataGridSource, /class="canvas-grid-surface dbx-data-grid-font-family/);
  assert.match(dataGridSource, /class="data-grid-scroller dbx-data-grid-font-family/);
});

test("invalidates grid measurements and canvas rendering when the result font changes", () => {
  assert.match(dataGridSource, /columnHeaderMeasurementKey = computed\(\(\) => \[tableFontSize\.value, tableFontFamily\.value\]\)/);
  assert.match(dataGridSource, /columnHeaderMeasureContext\.font = `600 \$\{tableFontSize\.value\}px \$\{tableFontFamily\.value\}`/);
  assert.match(dataGridSource, /canvasRenderStyleKey = computed\(\(\) => `[^`]*\$\{tableFontFamily\.value\}:\$\{tableFontSize\.value\}`\)/);
});

test("places the result grid font beside the interface font in appearance settings", () => {
  const editorSectionStart = settingsDialogSource.indexOf(`activeSettingsTab === 'editor'`);
  const appearanceSectionStart = settingsDialogSource.indexOf(`activeSettingsTab === 'appearance'`);
  const resultGridFontField = settingsDialogSource.indexOf(`<Label class="min-w-0 whitespace-normal leading-tight">{{ t("settings.dataGridFontFamily") }}</Label>`);

  assert.ok(editorSectionStart >= 0);
  assert.ok(appearanceSectionStart > editorSectionStart);
  assert.ok(resultGridFontField > appearanceSectionStart);
  assert.equal(settingsDialogSource.slice(editorSectionStart, appearanceSectionStart).includes(`settings.dataGridFontFamily`), false);
});

test("keeps appearance section spacing and help icons aligned without stacked margins", () => {
  assert.doesNotMatch(settingsDialogSource, /\.settings-appearance-section > \* \+ \*/);
  assert.match(settingsDialogSource, /activeSettingsTab === 'appearance'" class="settings-appearance-section flex flex-col gap-4 py-2"/);
  assert.match(settingsDialogSource, /<div class="flex min-w-0 items-center gap-1">\s*<Label class="min-w-0 whitespace-normal leading-tight">\{\{ t\("settings\.dataGridFontFamily"\) \}\}<\/Label>/);
});

test("matches the result grid font selector styling with date and time selectors", () => {
  const selectorStart = settingsDialogSource.indexOf(`:model-value="editTableFontFamily"`);
  const selectorEnd = settingsDialogSource.indexOf(`</SearchableSelect>`, selectorStart);
  const selectorSource = settingsDialogSource.slice(selectorStart, selectorEnd);

  assert.ok(selectorStart >= 0);
  assert.ok(selectorEnd > selectorStart);
  assert.match(selectorSource, /trigger-variant="outline"/);
  assert.match(selectorSource, /trigger-class="h-9 w-full max-w-none justify-between"/);
});

test("uses a table font label in view options without changing the settings label", () => {
  assert.match(quickControlSource, /t\("grid\.tableFontFamily"\)/);
  assert.doesNotMatch(quickControlSource, /t\("settings\.dataGridFontFamily"\)/);
  assert.match(settingsDialogSource, /t\("settings\.dataGridFontFamily"\)/);
});
