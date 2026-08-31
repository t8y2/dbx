import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { compileScript, parse } from "vue/compiler-sfc";
import { createDataGridCellContextMenuItems } from "../../apps/desktop/src/lib/dataGrid/dataGridContextMenu";

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

test("generated selection values restore grid focus for keyboard shortcuts", () => {
  const applyHandler = dataGridSource.match(/function applyGeneratedSelectionValue\([^]*?\n\}/)?.[0] ?? "";

  assert.match(applyHandler, /if \(applied\)[^]*nextTick\(\(\) => window\.requestAnimationFrame\(\(\) => gridRef\.value\?\.focus\(\{ preventScroll: true \}\)\)\)/);
});

test("column-header context menus defer copy statement generation", () => {
  const handler = dataGridSource.match(/function onHeaderContext\([^]*?\n\}/)?.[0] ?? "";

  assert.doesNotMatch(handler, /prefetchCopyStatements/);
});

test("context-menu invalidation clears cell and header targets together", () => {
  const handler = dataGridSource.match(/function invalidateContextMenuTarget\(\) \{[^]*?\n\}/)?.[0] ?? "";

  assert.match(handler, /contextSelectionIsSynthetic\.value = false;/);
  assert.match(handler, /contextCell\.value = null;/);
  assert.match(handler, /contextHeaderColumn\.value = null;/);
  assert.match(handler, /contextHeaderColumnIndex\.value = null;/);
  assert.match(handler, /contextHeaderVisibleColIdx\.value = null;/);
});

test("select-all context menus invalidate a stale specialized target", () => {
  const header = dataGridSource.match(/<div\s+class="data-grid-header-cell shrink-0 px-2 py-1\.5[^]*?@click="selectAllCells"[^]*?>/u)?.[0] ?? "";

  assert.match(header, /@contextmenu="invalidateContextMenuTarget"/);
});

test("right-clicking outside the old cell or column selection resets it before selecting the target", () => {
  const handler = dataGridSource.match(/function onCellContext\([^]*?\n\}/)?.[0] ?? "";
  const clear = handler.indexOf("clearCellSelection();");
  const select = handler.indexOf("selectSingleCell(rowIndex, visibleColIdx);");

  assert.ok(clear >= 0);
  assert.ok(clear < select);
});

test("menu-close invalidation is deferred and guarded from a newer open", () => {
  const handler = dataGridSource.match(/function onGridContextMenuClose\(\) \{[^]*?\n\}/)?.[0] ?? "";

  assert.match(handler, /queueMicrotask\(\(\) => \{/);
  assert.match(handler, /if \(lifecycle !== contextMenuLifecycle\) return;/);
  assert.match(handler, /invalidateContextMenuTarget\(\);/);
});

test("editable cell selections expose generation after bulk edit", () => {
  const icon = {};
  const action = () => {};
  const items = createDataGridCellContextMenuItems({
    hasCell: false,
    hasColumn: false,
    headerColumn: false,
    editable: true,
    hasCellSelection: true,
    hasEditableSelection: false,
    hasSelection: false,
    labels: { cellDetails: "cell", columnDetails: "column", rowDetails: "row", setNull: "set null", bulkEdit: "bulk edit", transpose: "transpose" },
    icons: { cellDetails: icon, columnDetails: icon, rowDetails: icon, setNull: icon, bulkEdit: icon, transpose: icon },
    actions: { cellDetails: action, columnDetails: action, rowDetails: action, setNull: action, bulkEdit: action, transpose: action },
    copySubmenu: { label: "copy" },
    selectionSubmenu: { label: "selection" },
    generateSubmenu: { label: "generate", disabled: true },
  });

  assert.deepEqual(
    items.map((item) => ({ label: item.label, disabled: item.disabled })),
    [
      { label: "copy", disabled: undefined },
      { label: "set null", disabled: true },
      { label: "bulk edit", disabled: true },
      { label: "generate", disabled: true },
    ],
  );
});
