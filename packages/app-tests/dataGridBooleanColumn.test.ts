import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { BOOLEAN_CELL_EDITOR_VALUES, booleanCellEditorValue, isBooleanCellValue, isBooleanColumnType, normalizeBooleanCellValue, parseBooleanCellEditorValue } from "../../apps/desktop/src/lib/dataGrid/dataGridBooleanColumn.ts";
import { resolveDataGridColumnsByResultIndex } from "../../apps/desktop/src/lib/dataGrid/dataGridColumnMetadata.ts";
import type { ColumnInfo } from "../../apps/desktop/src/types/database.ts";

function column(name: string, dataType: string): ColumnInfo {
  return {
    name,
    data_type: dataType,
    is_nullable: true,
    column_default: null,
    is_primary_key: false,
    extra: null,
  };
}

test("detects boolean types using database semantics", () => {
  assert.equal(isBooleanColumnType("boolean"), true);
  assert.equal(isBooleanColumnType("bool", "postgres"), true);
  assert.equal(isBooleanColumnType("bit", "sqlserver"), true);
  assert.equal(isBooleanColumnType("boolean", "mysql"), true);
  assert.equal(isBooleanColumnType("  BOOLEAN ", "postgres"), true);
});

test("does not treat database bit strings or MySQL integer aliases as boolean", () => {
  assert.equal(isBooleanColumnType("bit", "postgres"), false);
  assert.equal(isBooleanColumnType("bit(1)", "postgres"), false);
  assert.equal(isBooleanColumnType("bit varying", "postgres"), false);
  assert.equal(isBooleanColumnType("varbit", "postgres"), false);
  assert.equal(isBooleanColumnType("bit", "opengauss"), false);
  assert.equal(isBooleanColumnType("bit", undefined), false);
  assert.equal(isBooleanColumnType("bit", "mysql"), false);
  assert.equal(isBooleanColumnType("bit(1)", "mysql"), false);
  assert.equal(isBooleanColumnType("bit(8)", "mysql"), false);
  assert.equal(isBooleanColumnType("tinyint(1)", "mysql"), false);
  assert.equal(isBooleanColumnType(undefined, "mysql"), false);
});

test("normalizes raw cell values to a tri-state boolean", () => {
  assert.equal(normalizeBooleanCellValue(true), true);
  assert.equal(normalizeBooleanCellValue(false), false);
  assert.equal(normalizeBooleanCellValue(1), true);
  assert.equal(normalizeBooleanCellValue(0), false);
  assert.equal(normalizeBooleanCellValue("true"), true);
  assert.equal(normalizeBooleanCellValue("false"), false);
  assert.equal(normalizeBooleanCellValue("t"), true);
  assert.equal(normalizeBooleanCellValue("0"), false);
  assert.equal(normalizeBooleanCellValue(null), null);
  assert.equal(normalizeBooleanCellValue(undefined), null);
  assert.equal(normalizeBooleanCellValue("maybe"), null);
});

test("opens boolean editors only for recognized boolean cell values", () => {
  assert.equal(isBooleanCellValue(true), true);
  assert.equal(isBooleanCellValue(0), true);
  assert.equal(isBooleanCellValue("false"), true);
  assert.equal(isBooleanCellValue(null), true);
  assert.equal(isBooleanCellValue(undefined), false);
  assert.equal(isBooleanCellValue("maybe"), false);
  assert.equal(isBooleanCellValue({}), false);
});

test("normalizes boolean values for the enum-style editor", () => {
  assert.deepEqual(BOOLEAN_CELL_EDITOR_VALUES, ["true", "false"]);
  assert.equal(booleanCellEditorValue(true), "true");
  assert.equal(booleanCellEditorValue(1), "true");
  assert.equal(booleanCellEditorValue(false), "false");
  assert.equal(booleanCellEditorValue("0"), "false");
  assert.equal(booleanCellEditorValue(null), "");
  assert.equal(booleanCellEditorValue("maybe"), "");
});

test("parses explicit enum-style boolean selections", () => {
  assert.equal(parseBooleanCellEditorValue("true"), true);
  assert.equal(parseBooleanCellEditorValue("false"), false);
  assert.equal(parseBooleanCellEditorValue(null), null);
  assert.equal(parseBooleanCellEditorValue("maybe"), undefined);
});

test("indexes table metadata once and resolves source-column aliases", () => {
  const enabled = column("Enabled", "boolean");
  const displayName = column("DisplayName", "varchar");
  const resolved = resolveDataGridColumnsByResultIndex({
    resultColumns: ["enabled_alias", "DisplayName", "missing"],
    sourceColumns: ["enabled", undefined, undefined],
    tableColumns: [enabled, displayName],
  });

  assert.equal(resolved[0], enabled);
  assert.equal(resolved[1], displayName);
  assert.equal(resolved[2], undefined);
});

test("uses the enum editor for boolean cells without checkbox rendering or click cycling", () => {
  const gridSource = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  const rendererSource = readFileSync("apps/desktop/src/lib/dataGrid/canvasDataGridRenderer.ts", "utf8");

  assert.match(gridSource, /v-else-if="isBooleanGridCell\([^\n]+"[\s\S]*?v-model="booleanEditorModelValue"[\s\S]*?:values="BOOLEAN_CELL_EDITOR_VALUES"/);
  assert.match(gridSource, /@commit="commitBooleanGridEdit"/);
  assert.doesNotMatch(gridSource, /cycleBooleanCellValue|tryCycleBooleanCheckboxOnCanvasMouseDown|booleanCellChecked/);
  assert.doesNotMatch(rendererSource, /drawBooleanCheckbox|BOOLEAN_CHECKBOX_SIZE|columnIsBoolean/);
});

test("uses the indexed metadata lookup in grid hot paths", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  const start = source.indexOf("function tableColumnForGridColumn");
  const end = source.indexOf("function resultColumnInfoForGridColumn", start);
  const lookup = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(lookup, /tableColumnsByResultIndex\.value\[columnIndex\]/);
  assert.doesNotMatch(lookup, /\.find\(/);
});
