import { test } from "vitest";
import assert from "node:assert/strict";
import type { ColumnInfo } from "../../apps/desktop/src/types/database.ts";
import { findMatchedSearchColumns, isNumericSearchColumn, isTextSearchColumn } from "../../apps/desktop/src/lib/databaseSearch.ts";

function col(name: string, dataType: string, primary = false): ColumnInfo {
  return {
    name,
    data_type: dataType,
    is_nullable: true,
    column_default: null,
    is_primary_key: primary,
    extra: null,
  };
}

test("classifies searchable database search columns", () => {
  assert.equal(isTextSearchColumn(col("email", "varchar")), true);
  assert.equal(isNumericSearchColumn(col("id", "bigint")), true);
  assert.equal(isTextSearchColumn(col("payload", "blob")), false);
  assert.equal(isNumericSearchColumn(col("payload", "blob")), false);
});

test("finds matched columns from returned rows", () => {
  const matches = findMatchedSearchColumns(["id", "email", "note"], [42, "Alice@Example.com", "inactive"], [col("id", "integer", true), col("email", "varchar"), col("note", "text")], "alice");

  assert.deepEqual(matches, ["email"]);
});
