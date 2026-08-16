import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { BOOLEAN_CELL_EDITOR_VALUES, booleanCellEditorValue, isBooleanCellValue, isBooleanColumnType, normalizeBooleanCellValue, parseBooleanCellEditorValue } from "../../apps/desktop/src/lib/dataGrid/dataGridBooleanColumn.ts";
import { resolveDataGridColumnNullability, resolveDataGridColumnsByResultIndex } from "../../apps/desktop/src/lib/dataGrid/dataGridColumnMetadata.ts";
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
  assert.equal(isBooleanColumnType("bit", "mysql"), true);
  assert.equal(isBooleanColumnType("bit(1)", "mysql"), true);
});

test("does not treat database bit strings or MySQL integer aliases as boolean", () => {
  assert.equal(isBooleanColumnType("bit", "postgres"), false);
  assert.equal(isBooleanColumnType("bit(1)", "postgres"), false);
  assert.equal(isBooleanColumnType("bit varying", "postgres"), false);
  assert.equal(isBooleanColumnType("varbit", "postgres"), false);
  assert.equal(isBooleanColumnType("bit", "opengauss"), false);
  assert.equal(isBooleanColumnType("bit", undefined), false);
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

test("shows nullability only for query results with resolved column metadata", () => {
  const nullable = column("nickname", "varchar");
  const required = { ...column("code", "varchar"), is_nullable: false };

  assert.equal(resolveDataGridColumnNullability("results", nullable), "nullable");
  assert.equal(resolveDataGridColumnNullability("results", required), "required");
  assert.equal(resolveDataGridColumnNullability("results", undefined), undefined);
  assert.equal(resolveDataGridColumnNullability("table-data", nullable), undefined);
  assert.equal(resolveDataGridColumnNullability(undefined, nullable), undefined);
});

test("keeps the enum editor as the default boolean edit path and gates checkbox interaction behind the checkbox display mode", () => {
  const gridSource = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  const rendererSource = readFileSync("apps/desktop/src/lib/dataGrid/canvasDataGridRenderer.ts", "utf8");

  assert.match(gridSource, /v-else-if="isBooleanGridCell\([^\n]+"[\s\S]*?v-model="booleanEditorModelValue"[\s\S]*?:values="BOOLEAN_CELL_EDITOR_VALUES"/);
  assert.match(gridSource, /@commit="commitBooleanGridEdit"/);
  // The editor-side cycle helper the old checkbox implementation depended on stays removed.
  assert.doesNotMatch(gridSource, /cycleBooleanCellValue/);
  // Checkbox rendering and click cycling only exist behind the checkbox display mode.
  assert.match(gridSource, /booleanCellsUseCheckbox\.value/);
  assert.match(rendererSource, /booleanDisplayMode === "checkbox"/);
});

test("DOM checkbox mode renders a clickable placeholder for null boolean cells so they can be cycled like canvas", () => {
  const gridSource = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  // Canvas surfaces null booleans via booleanNullTextHitFromCanvasEvent (click the NULL text to cycle).
  // The DOM path must offer the same affordance: a null boolean cell in checkbox mode renders its NULL
  // text with a click handler that triggers cycleBooleanGridCell, instead of falling through to the
  // static v-else text (which cannot be cycled and is short-circuited by onDomCellDblClick).
  const domCellBranch = gridSource.match(/<template v-else-if="booleanCellsUseCheckbox && isBooleanGridCell\([^\n]+=== null[\s\S]*?cycleBooleanGridCell/);
  assert.ok(domCellBranch, "DOM checkbox mode must render a clickable cycle placeholder for null boolean cells");
  assert.match(domCellBranch![0], /@click\.stop="cycleBooleanGridCell/);
  assert.match(domCellBranch![0], /text-muted-foreground/);
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
