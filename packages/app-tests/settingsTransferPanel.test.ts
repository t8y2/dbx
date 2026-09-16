import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc";

const panelPath = "apps/desktop/src/components/settings/SettingsTransferPanel.vue";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

test("settings transfer panel SFC compiles", () => {
  const { descriptor, errors } = parse(source(panelPath), { filename: panelPath });
  assert.deepEqual(errors, [], `${panelPath} should parse without SFC errors`);
  assert.ok(descriptor.scriptSetup, `${panelPath} should have a script setup block`);
  compileScript(descriptor, { id: panelPath });
  assert.ok(descriptor.template, `${panelPath} should have a template`);
  const result = compileTemplate({ id: panelPath, filename: panelPath, source: descriptor.template.content });
  assert.deepEqual(result.errors, [], `${panelPath} template should compile`);
});

test("about-page settings transfer buttons follow local-container icon semantics", () => {
  const panel = source(panelPath);

  // Treat the app as a local container: import brings data in (Download),
  // export sends data out (Upload). Same contract as SQL library / formatter.
  assert.match(panel, /@click="onImportClick"[\s\S]{0,200}<Download v-else/);
  assert.match(panel, /@click="onExportClick"[\s\S]{0,200}<Upload v-else/);
  assert.doesNotMatch(panel, /@click="onImportClick"[\s\S]{0,200}<Upload v-else/);
  assert.doesNotMatch(panel, /@click="onExportClick"[\s\S]{0,200}<Download v-else/);
});
