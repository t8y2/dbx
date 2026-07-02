import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  DBX_NEO4J_ELEMENT_ID_COLUMN,
  DBX_ROWID_COLUMN,
  DBX_TDENGINE_TBNAME_COLUMN,
  canEditExistingTableRows,
  canInsertTableRows,
  editablePrimaryKeys,
  hiveTablePropertiesIndicateTransactional,
  isHiddenGridColumn,
  isTdengineExistingRowReadonlyColumn,
  isTableDataEditable,
  supportsDataGridTransaction,
  usesSyntheticRowIdKey,
} from "../../apps/desktop/src/lib/tableEditing.ts";
import type { ColumnInfo } from "../../apps/desktop/src/types/database.ts";

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

test("uses tbname and timestamp as TDengine editable keys", () => {
  assert.deepEqual(editablePrimaryKeys("tdengine", [column("ts", true), column("current")]), [DBX_TDENGINE_TBNAME_COLUMN, "ts"]);
});

test("allows updateable SQL table data editing even without declared primary keys", () => {
  assert.equal(isTableDataEditable("access", []), true);
  assert.equal(isTableDataEditable("sqlite", []), true);
  assert.equal(isTableDataEditable("duckdb", []), true);
  assert.equal(isTableDataEditable("dameng", []), true);
  assert.equal(isTableDataEditable("hive", []), true);
  assert.equal(isTableDataEditable("trino", []), true);
  assert.equal(isTableDataEditable("informix", []), true);
  assert.equal(isTableDataEditable("tdengine", []), true);
  assert.equal(isTableDataEditable("mysql", []), true);
  assert.equal(isTableDataEditable("manticoresearch", []), true);
  assert.equal(isTableDataEditable("databend", []), true);
  assert.equal(isTableDataEditable("postgres", []), true);
  assert.equal(isTableDataEditable("postgres", ["id"]), true);
});

test("does not use transactional grid saves for non-transactional engines", () => {
  assert.equal(supportsDataGridTransaction("hive"), false);
  assert.equal(supportsDataGridTransaction("manticoresearch"), false);
  assert.equal(supportsDataGridTransaction("trino"), false);
  assert.equal(supportsDataGridTransaction("jdbc"), false);
  assert.equal(supportsDataGridTransaction("yashandb"), true);
  assert.equal(supportsDataGridTransaction("postgres"), true);
});

test("detects whether table data supports inserted rows", () => {
  assert.equal(canInsertTableRows("postgres"), true);
  assert.equal(canInsertTableRows("mysql"), true);
  assert.equal(canInsertTableRows("hive"), true);
  assert.equal(canInsertTableRows("jdbc"), false);
  assert.equal(canInsertTableRows("clickhouse"), true);
  assert.equal(canInsertTableRows("influxdb"), false);
});

test("allows existing row edits according to database-specific key requirements", () => {
  assert.equal(canEditExistingTableRows("access", undefined, []), true);
  assert.equal(canEditExistingTableRows("access", undefined, ["ID"]), true);
  assert.equal(canEditExistingTableRows("dameng", undefined, []), true);
  assert.equal(canEditExistingTableRows("dameng", undefined, ["ID"]), true);
  assert.equal(canEditExistingTableRows("hive", true), true);
  assert.equal(canEditExistingTableRows("hive", false), false);
  assert.equal(canEditExistingTableRows("hive", undefined), false);
  assert.equal(canEditExistingTableRows("trino", undefined, []), false);
  assert.equal(canEditExistingTableRows("trino", undefined, ["id"]), true);
  assert.equal(canEditExistingTableRows("mysql", undefined, []), true);
  assert.equal(canEditExistingTableRows("manticoresearch", undefined, []), true);
  assert.equal(canEditExistingTableRows("databend", undefined, []), true);
  assert.equal(canEditExistingTableRows("postgres", undefined, []), true);
  assert.equal(canEditExistingTableRows("sqlite", undefined, []), true);
  assert.equal(canEditExistingTableRows("sqlite", undefined, ["id"]), true);
  assert.equal(canEditExistingTableRows("duckdb", undefined, []), true);
  assert.equal(canEditExistingTableRows("duckdb", undefined, ["id"]), true);
  assert.equal(canEditExistingTableRows("informix", undefined, []), true);
  assert.equal(canEditExistingTableRows("informix", undefined, ["id"]), true);
  assert.equal(canEditExistingTableRows("tdengine", undefined, ["ts"]), false);
  assert.equal(canEditExistingTableRows("tdengine", undefined, [DBX_TDENGINE_TBNAME_COLUMN, "ts"]), true);
  assert.equal(canEditExistingTableRows("postgres", undefined), true);
});

test("detects transactional Hive table properties", () => {
  assert.equal(
    hiveTablePropertiesIndicateTransactional({
      columns: ["prpt_name", "prpt_value"],
      rows: [["transactional", "true"]],
    }),
    true,
  );
  assert.equal(
    hiveTablePropertiesIndicateTransactional({
      columns: ["prpt_name", "prpt_value"],
      rows: [["Table testdb.departments does not have property: transactional", null]],
    }),
    false,
  );
});

test("uses elementId as Neo4j editable key when labels have no primary key", () => {
  assert.deepEqual(editablePrimaryKeys("neo4j", [column("name"), column("role")]), [DBX_NEO4J_ELEMENT_ID_COLUMN]);
});

test("keeps TDengine existing row identity and tag columns read-only", () => {
  assert.equal(isTdengineExistingRowReadonlyColumn("tdengine", DBX_TDENGINE_TBNAME_COLUMN, [column("ts", true)]), true);
  assert.equal(isTdengineExistingRowReadonlyColumn("tdengine", "ts", [column("ts", true)]), true);
  assert.equal(isTdengineExistingRowReadonlyColumn("tdengine", "location", [column("location")]), false);
  assert.equal(isTdengineExistingRowReadonlyColumn("mysql", "ts", [column("ts", true)]), false);
  assert.equal(isTdengineExistingRowReadonlyColumn("tdengine", "location", [{ ...column("location"), extra: "TAG", comment: "TAG" }]), true);
});

test("detects the synthetic Oracle ROWID key case", () => {
  assert.equal(usesSyntheticRowIdKey("oracle", [DBX_ROWID_COLUMN]), true);
  assert.equal(usesSyntheticRowIdKey("oracle", [DBX_ROWID_COLUMN.toLowerCase()]), true);
  assert.equal(usesSyntheticRowIdKey("postgres", [DBX_ROWID_COLUMN]), false);
  assert.equal(usesSyntheticRowIdKey("oracle", ["ID"]), false);
  assert.equal(usesSyntheticRowIdKey("neo4j", [DBX_NEO4J_ELEMENT_ID_COLUMN]), true);
});

test("hides only the synthetic Oracle ROWID grid column", () => {
  assert.equal(isHiddenGridColumn("oracle", DBX_ROWID_COLUMN, [DBX_ROWID_COLUMN]), true);
  assert.equal(isHiddenGridColumn("oracle", "ROWID", [DBX_ROWID_COLUMN]), false);
  assert.equal(isHiddenGridColumn("mysql", DBX_ROWID_COLUMN, [DBX_ROWID_COLUMN]), false);
  assert.equal(isHiddenGridColumn("neo4j", DBX_NEO4J_ELEMENT_ID_COLUMN, [DBX_NEO4J_ELEMENT_ID_COLUMN]), true);
});
