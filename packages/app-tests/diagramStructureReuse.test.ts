import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  createDraftTable,
  createEmptyColumn,
  draftTableToCreateSqlOptions,
  liveTableToAlterSqlOptions,
} from "../../apps/desktop/src/lib/diagram/draft-table.ts";
import type { DiagramTable } from "../../apps/desktop/src/lib/diagram/erDiagram.ts";
import { canAddTableStructureColumn, getTableStructureCapabilities } from "../../apps/desktop/src/lib/table/tableStructureCapabilities.ts";
import { supportsTableStructureEditing } from "../../apps/desktop/src/lib/database/databaseFeatureSupport.ts";
import { defaultNewColumnDataType, getDataTypeOptions } from "../../apps/desktop/src/lib/table/tableStructureEditorState.ts";
import type { DatabaseType } from "../../apps/desktop/src/types/database.ts";

const READY_DIALECTS: DatabaseType[] = ["mysql", "postgres", "sqlite", "sqlserver", "oracle"];

test("diagram structure gates reuse TableStructure capabilities", () => {
  for (const dbType of READY_DIALECTS) {
    const caps = getTableStructureCapabilities(dbType);
    assert.equal(caps.createTable, true, `${dbType} createTable`);
    assert.equal(canAddTableStructureColumn(dbType, true), caps.createTable);
    assert.equal(canAddTableStructureColumn(dbType, false), caps.addColumn);
    assert.equal(supportsTableStructureEditing(dbType), true, `${dbType} structure editing`);
  }

  const unsupported = getTableStructureCapabilities("mongodb");
  assert.equal(unsupported.createTable, false);
  assert.equal(canAddTableStructureColumn("mongodb", true), false);
  assert.equal(canAddTableStructureColumn("mongodb", false), false);
  assert.equal(supportsTableStructureEditing("mongodb"), false);
});

test("draft CREATE options match table-structure SQL API shape", () => {
  for (const dbType of READY_DIALECTS) {
    const table = createDraftTable("users", { databaseType: dbType });
    const options = draftTableToCreateSqlOptions(table, dbType, dbType === "postgres" ? "public" : undefined);
    assert.equal(options.databaseType, dbType);
    assert.equal(options.tableName, "users");
    assert.ok(Array.isArray(options.columns));
    assert.ok(Array.isArray(options.indexes));
    assert.deepEqual(options.foreignKeys, []);
    assert.deepEqual(options.triggers, []);
    assert.equal(options.columns[0]?.isPrimaryKey, true);
    assert.ok(options.columns[0]?.dataType);
  }
});

test("live ALTER options mark pending add and drop for shared change SQL API", () => {
  const table: DiagramTable = {
    name: "orders",
    columns: [
      { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
      { name: "note", data_type: "text", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
    ],
    foreignKeys: [],
    origin: "database",
    pendingColumnNames: ["note"],
    droppedColumnNames: ["id"],
  };
  const options = liveTableToAlterSqlOptions(table, "postgres", "public");
  assert.equal(options.databaseType, "postgres");
  assert.equal(options.tableName, "orders");
  assert.deepEqual(options.indexes, []);
  assert.deepEqual(options.foreignKeys, []);
  const pending = options.columns.find((column) => column.name === "note");
  const dropped = options.columns.find((column) => column.name === "id");
  assert.ok(pending);
  assert.equal(pending?.original, undefined);
  assert.ok(dropped?.original);
  assert.equal(dropped?.markedForDrop, true);
});

test("empty column defaults come from shared tableStructureEditorState", () => {
  assert.equal(createEmptyColumn("x", "postgres").data_type, defaultNewColumnDataType("postgres", getDataTypeOptions("postgres")));
  assert.equal(createEmptyColumn("x", "duckdb").data_type, defaultNewColumnDataType("duckdb", getDataTypeOptions("duckdb")));
  assert.equal(createEmptyColumn("x", "h2").data_type, defaultNewColumnDataType("h2", getDataTypeOptions("h2")));
  assert.ok(getDataTypeOptions("duckdb").length > 0);
  assert.ok(getDataTypeOptions("h2").length > 0);
  assert.ok(getDataTypeOptions("rqlite").includes("text"));
});
