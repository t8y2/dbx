import { strict as assert } from "node:assert";
import { test } from "vitest";
import { isBooleanColumnType, nextBooleanCellValue, normalizeBooleanCellValue } from "../../apps/desktop/src/lib/dataGrid/dataGridBooleanColumn.ts";

test("detects native boolean/bit column types", () => {
  assert.equal(isBooleanColumnType("boolean"), true);
  assert.equal(isBooleanColumnType("bool"), true);
  assert.equal(isBooleanColumnType("bit"), true);
  assert.equal(isBooleanColumnType("bit(1)"), true);
  assert.equal(isBooleanColumnType("  BOOLEAN "), true);
  assert.equal(isBooleanColumnType("BIT"), true);
});

test("does not treat wide bit fields, tinyint, or other types as boolean", () => {
  assert.equal(isBooleanColumnType("bit(8)"), false);
  assert.equal(isBooleanColumnType("tinyint(1)"), false);
  assert.equal(isBooleanColumnType("tinyint"), false);
  assert.equal(isBooleanColumnType("bigint"), false);
  assert.equal(isBooleanColumnType("varchar(255)"), false);
  assert.equal(isBooleanColumnType(undefined), false);
  assert.equal(isBooleanColumnType(""), false);
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

test("cycles true -> false -> true for NOT NULL columns", () => {
  assert.equal(nextBooleanCellValue(true, false), false);
  assert.equal(nextBooleanCellValue(false, false), true);
  // Defensive: a stray null on a NOT NULL column goes to true.
  assert.equal(nextBooleanCellValue(null, false), true);
});

test("cycles true -> false -> null -> true for nullable columns", () => {
  assert.equal(nextBooleanCellValue(true, true), false);
  assert.equal(nextBooleanCellValue(false, true), null);
  assert.equal(nextBooleanCellValue(null, true), true);
});
