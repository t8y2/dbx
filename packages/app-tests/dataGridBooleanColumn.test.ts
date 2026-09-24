import { strict as assert } from "node:assert";
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

test("indexes table metadata once and honors explicit source-column mappings", () => {
  const enabled = column("Enabled", "boolean");
  const displayName = column("DisplayName", "varchar");
  const explicitlyMapped = resolveDataGridColumnsByResultIndex({
    resultColumns: ["enabled_alias", "DisplayName", "missing"],
    sourceColumns: ["enabled", undefined, undefined],
    tableColumns: [enabled, displayName],
  });
  const inferred = resolveDataGridColumnsByResultIndex({
    resultColumns: ["DisplayName"],
    tableColumns: [enabled, displayName],
  });

  assert.equal(explicitlyMapped[0], enabled);
  assert.equal(explicitlyMapped[1], undefined);
  assert.equal(explicitlyMapped[2], undefined);
  assert.equal(inferred[0], displayName);
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
