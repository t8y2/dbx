import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { isBooleanCheckboxValue, isBooleanColumnType, nextBooleanCellValue, normalizeBooleanCellValue } from "../../apps/desktop/src/lib/dataGrid/dataGridBooleanColumn.ts";
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
  assert.equal(isBooleanColumnType("bit", "mysql"), true);
  assert.equal(isBooleanColumnType("bit(1)", "mysql"), true);
  assert.equal(isBooleanColumnType("  BOOLEAN ", "postgres"), true);
});

test("does not treat PostgreSQL bit strings or unknown bit semantics as boolean", () => {
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

test("shows checkboxes only for recognized boolean cell values", () => {
  assert.equal(isBooleanCheckboxValue(true), true);
  assert.equal(isBooleanCheckboxValue(0), true);
  assert.equal(isBooleanCheckboxValue("false"), true);
  assert.equal(isBooleanCheckboxValue(null), true);
  assert.equal(isBooleanCheckboxValue(undefined), false);
  assert.equal(isBooleanCheckboxValue("maybe"), false);
  assert.equal(isBooleanCheckboxValue({}), false);
});

test("cycles true -> false -> true for NOT NULL columns", () => {
  assert.equal(nextBooleanCellValue(true, false), false);
  assert.equal(nextBooleanCellValue(false, false), true);
  assert.equal(nextBooleanCellValue(null, false), true);
});

test("cycles true -> false -> null -> true for nullable columns", () => {
  assert.equal(nextBooleanCellValue(true, true), false);
  assert.equal(nextBooleanCellValue(false, true), null);
  assert.equal(nextBooleanCellValue(null, true), true);
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

test("runs canvas selection before toggling a checkbox", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  const start = source.indexOf("function onCanvasMouseDown");
  const end = source.indexOf("function onCanvasContext", start);
  const handler = source.slice(start, end);
  const selectionIndex = handler.indexOf("handleDataCellMousedown");
  const toggleIndex = handler.indexOf("tryCycleBooleanCheckboxOnCanvasMouseDown");

  assert.ok(start >= 0 && end > start);
  assert.ok(selectionIndex >= 0);
  assert.ok(toggleIndex >= 0);
  assert.ok(selectionIndex < toggleIndex);
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
