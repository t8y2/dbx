import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc";

const editorPath = "apps/desktop/src/components/grid/DataGridConditionEditor.vue";
const controlsPath = "apps/desktop/src/components/grid/DataGridQueryControls.vue";
const dataGridPath = "apps/desktop/src/components/grid/DataGrid.vue";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function assertSfcCompiles(path: string): void {
  const { descriptor, errors } = parse(source(path), { filename: path });
  assert.deepEqual(errors, []);
  assert.ok(descriptor.scriptSetup);
  assert.ok(descriptor.template);
  compileScript(descriptor, { id: path });
  const result = compileTemplate({ id: path, filename: path, source: descriptor.template.content });
  assert.deepEqual(result.errors, []);
}

test("condition suggestion components compile with structured column details", () => {
  for (const path of [editorPath, controlsPath, dataGridPath]) assertSfcCompiles(path);
});

test("condition suggestions display comments without adding them to inserted values", () => {
  const editor = source(editorPath);
  const controls = source(controlsPath);
  const dataGrid = source(dataGridPath);

  assert.match(editor, /suggestion\.kind === 'column' && suggestion\.detail/);
  assert.match(editor, /data-condition-suggestion-detail/);
  assert.match(editor, /:title="suggestion\.detail"/);
  assert.match(controls, /:columns="conditionColumns \?\? columns"/);
  assert.equal((controls.match(/:columns="conditionColumns \?\? columns"/g) ?? []).length, 2);
  assert.match(dataGrid, /:condition-columns="conditionColumnSuggestions"/);
  assert.match(dataGrid, /detail: column\.comment\?\.trim\(\) \|\| undefined/);
});
