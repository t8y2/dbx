import { test } from "vitest";
import assert from "node:assert/strict";
import type { ColumnInfo } from "../../apps/desktop/src/types/database.ts";
import { findMatchedSearchColumns, isNumericSearchColumn, isTextSearchColumn } from "../../apps/desktop/src/lib/database/databaseSearch.ts";
import { DATABASE_SEARCH_TABLE_BATCH_SIZE, databaseSearchBatchRange, databaseSearchNextBatchSize } from "../../apps/desktop/src/lib/database/databaseSearchBatch.ts";

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

test("treats 200 tables as a resumable batch instead of a search cap", () => {
  assert.equal(DATABASE_SEARCH_TABLE_BATCH_SIZE, 200);
  assert.deepEqual(databaseSearchBatchRange(0, 450), { start: 0, end: 200 });
  assert.deepEqual(databaseSearchBatchRange(200, 450), { start: 200, end: 400 });
  assert.deepEqual(databaseSearchBatchRange(400, 450), { start: 400, end: 450 });
  assert.equal(databaseSearchNextBatchSize(400, 450), 50);
});

test("can scan every remaining table without exceeding the discovered table list", () => {
  assert.deepEqual(databaseSearchBatchRange(200, 450, true), { start: 200, end: 450 });
  assert.deepEqual(databaseSearchBatchRange(999, 450, true), { start: 450, end: 450 });
  assert.deepEqual(databaseSearchBatchRange(-10, 5, false, 0), { start: 0, end: 1 });
});
