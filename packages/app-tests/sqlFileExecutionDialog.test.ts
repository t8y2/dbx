import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc";

const dialogPath = "apps/desktop/src/components/sql-file/SqlFileExecutionDialog.vue";
const dialogSource = readFileSync(dialogPath, "utf8");

test("SQL file execution dialog SFC compiles", () => {
  const { descriptor, errors } = parse(dialogSource, { filename: dialogPath });
  assert.deepEqual(errors, []);
  assert.ok(descriptor.scriptSetup);
  compileScript(descriptor, { id: dialogPath });
  assert.ok(descriptor.template);
  const result = compileTemplate({ id: dialogPath, filename: dialogPath, source: descriptor.template.content });
  assert.deepEqual(result.errors, []);
});

test("SQL file execution dialog keeps actions visible within narrow viewports", () => {
  assert.match(dialogSource, /DialogScrollContent class="[^"]*max-h-\[calc\(var\(--dbx-viewport-height\)-6rem\)\][^"]*flex-col[^"]*overflow-hidden/);
  assert.match(dialogSource, /<DialogHeader class="shrink-0">/);
  assert.match(dialogSource, /class="grid min-h-0 min-w-0 flex-1 gap-4 overflow-y-auto py-3"/);
  assert.match(dialogSource, /class="grid grid-cols-1 gap-3 sm:grid-cols-2"/);
  assert.match(dialogSource, /<DialogFooter class="shrink-0">/);
});

test("SQL file execution dialog preserves cancel, close, and retry actions", () => {
  assert.match(dialogSource, /<template v-if="running">[\s\S]*@click="open = false"[\s\S]*@click="cancelExecution"/);
  assert.match(dialogSource, /<template v-else>[\s\S]*@click="open = false"[\s\S]*:disabled="!canStart" @click="startExecution"/);
  assert.match(dialogSource, /terminalStatus\.value = cancelRequested\.value \? "cancelled" : "error"/);
});
