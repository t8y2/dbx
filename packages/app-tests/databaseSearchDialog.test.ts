import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc";

const dialogPath = "apps/desktop/src/components/search/DatabaseSearchDialog.vue";
const dialogSource = readFileSync(dialogPath, "utf8");

test("database search dialog compiles", () => {
  const { descriptor, errors } = parse(dialogSource, { filename: dialogPath });
  assert.deepEqual(errors, []);
  assert.ok(descriptor.scriptSetup);
  compileScript(descriptor, { id: dialogPath });
  assert.ok(descriptor.template);
  const template = compileTemplate({ id: dialogPath, filename: dialogPath, source: descriptor.template!.content });
  assert.deepEqual(template.errors, []);
});

test("database search continues after each table batch without retaining a hard cap", () => {
  assert.doesNotMatch(dialogSource, /MAX_TABLES|tasks\.slice\(0/);
  assert.match(dialogSource, /progressTotal\.value = tableTasks\.value\.length/);
  assert.match(dialogSource, /await scanTableRange\(currentRun, false\)/);
  assert.match(dialogSource, /@click="continueSearch\(false\)"/);
  assert.match(dialogSource, /@click="continueSearch\(true\)"/);
  assert.match(dialogSource, /activeKeyword\.value/);
  assert.match(dialogSource, /activePerTableLimit\.value/);
  assert.match(dialogSource, /const tableResults: SearchResultItem\[\] = \[\]/);
  assert.match(dialogSource, /currentRun === runId && !cancelled\.value/);
});
