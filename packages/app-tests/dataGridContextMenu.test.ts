import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { compileScript, parse } from "vue/compiler-sfc";

const dataGridPath = "apps/desktop/src/components/grid/DataGrid.vue";
const dataGridSource = readFileSync(dataGridPath, "utf8");

test("DataGrid context menu script compiles", () => {
  const { descriptor, errors } = parse(dataGridSource, { filename: dataGridPath });

  assert.deepEqual(errors, []);
  assert.ok(descriptor.scriptSetup);
  compileScript(descriptor, { id: "data-grid-context-menu-test" });
});

test("set NULL applies a real null value only to editable selections", () => {
  const handler = dataGridSource.match(/function setSelectionNull\(\) \{[^]*?\n\}/)?.[0] ?? "";

  assert.match(handler, /if \(!props\.editable \|\| !selectionHasEditableCells\(\)\) return;/);
  assert.match(handler, /fillSelectionWithValue\(null\);/);
  assert.doesNotMatch(handler, /fillSelectionWithValue\(["'](?:NULL)?["']\)/);
});

test("editable cell selections expose set NULL before bulk edit", () => {
  const menuBlock = dataGridSource.match(/if \(props\.editable && hasCellSelection\.value\) \{[^]*?\n  \}/)?.[0] ?? "";

  assert.match(menuBlock, /const hasEditableSelection = selectionHasEditableCells\(\);/);
  assert.match(menuBlock, /if \(!contextHeaderColumn\.value\) \{/);
  assert.match(menuBlock, /label: t\("grid\.setNull"\),\s+action: setSelectionNull,\s+disabled: !hasEditableSelection,\s+icon: X,/);
  assert.match(menuBlock, /label: t\("grid\.bulkEditSelection"\),\s+action: openBulkEditDialog,\s+disabled: !hasEditableSelection,/);
  assert.ok(menuBlock.indexOf('t("grid.setNull")') < menuBlock.indexOf('t("grid.bulkEditSelection")'));
});
