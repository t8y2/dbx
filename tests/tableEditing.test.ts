import { strict as assert } from "node:assert";
import test from "node:test";
import {
  DBX_ROWID_COLUMN,
  editablePrimaryKeys,
  isHiddenGridColumn,
  usesSyntheticRowIdKey,
} from "../src/lib/tableEditing.ts";
import type { ColumnInfo } from "../src/types/database.ts";

function column(name: string, isPrimaryKey = false): ColumnInfo {
  return {
    name,
    data_type: "VARCHAR2",
    is_nullable: true,
    column_default: null,
    is_primary_key: isPrimaryKey,
    extra: null,
  };
}

test("uses ROWID as Oracle editable key when a table has no primary key", () => {
  assert.deepEqual(editablePrimaryKeys("oracle", [column("ID"), column("CITY")]), [DBX_ROWID_COLUMN]);
});

test("keeps declared primary keys ahead of Oracle ROWID fallback", () => {
  assert.deepEqual(editablePrimaryKeys("oracle", [column("ID", true), column("CITY")]), ["ID"]);
});

test("does not synthesize ROWID for non-Oracle keyless tables", () => {
  assert.deepEqual(editablePrimaryKeys("mysql", [column("ID"), column("CITY")]), []);
});

test("detects the synthetic Oracle ROWID key case", () => {
  assert.equal(usesSyntheticRowIdKey("oracle", [DBX_ROWID_COLUMN]), true);
  assert.equal(usesSyntheticRowIdKey("oracle", [DBX_ROWID_COLUMN.toLowerCase()]), true);
  assert.equal(usesSyntheticRowIdKey("postgres", [DBX_ROWID_COLUMN]), false);
  assert.equal(usesSyntheticRowIdKey("oracle", ["ID"]), false);
});

test("hides only the synthetic Oracle ROWID grid column", () => {
  assert.equal(isHiddenGridColumn("oracle", DBX_ROWID_COLUMN, [DBX_ROWID_COLUMN]), true);
  assert.equal(isHiddenGridColumn("oracle", "ROWID", [DBX_ROWID_COLUMN]), false);
  assert.equal(isHiddenGridColumn("mysql", DBX_ROWID_COLUMN, [DBX_ROWID_COLUMN]), false);
});
