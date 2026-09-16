import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  createDraftIndex,
  createDraftTable,
  createEmptyColumn,
  draftTableToCreateSqlOptions,
  nextUniqueColumnName,
  validateDraftTable,
} from "../../apps/desktop/src/lib/diagram/draft-table.ts";
import { isDraftTable } from "../../apps/desktop/src/lib/diagram/erDiagram.ts";
import type { EditableStructureIndex } from "../../apps/desktop/src/lib/table/tableStructureEditorSql.ts";

test("createDraftTable marks origin draft and optional id pk", () => {
  const withId = createDraftTable("users");
  assert.equal(withId.origin, "draft");
  assert.equal(isDraftTable(withId), true);
  assert.equal(withId.columns.length, 1);
  assert.equal(withId.columns[0].name, "id");
  assert.equal(withId.columns[0].is_primary_key, true);

  const empty = createDraftTable("orders", { withDefaultId: false });
  assert.equal(empty.columns.length, 0);
  assert.deepEqual(validateDraftTable(empty), ['Table "orders" needs at least one column']);
});

test("validateDraftTable catches duplicates", () => {
  const table = createDraftTable("t", { withDefaultId: false });
  table.columns = [createEmptyColumn("a"), createEmptyColumn("a")];
  const errors = validateDraftTable(table);
  assert.ok(errors.some((e) => e.includes("duplicate")));
});

test("nextUniqueColumnName increments", () => {
  assert.equal(nextUniqueColumnName([{ name: "column_1", data_type: "int", is_nullable: true, column_default: null, is_primary_key: false, extra: null }]), "column_2");
});

test("createDraftIndex generates unique names", () => {
  const first = createDraftIndex("users", ["email"]);
  const second = createDraftIndex("users", ["email"], [first]);
  assert.ok(first.name);
  assert.ok(second.name);
  assert.notEqual(first.name, second.name);
  assert.deepEqual(first.columns, ["email"]);
});

test("validateDraftTable catches empty name and index errors", () => {
  const table = createDraftTable("  ", { withDefaultId: false });
  table.columns = [createEmptyColumn("id")];
  const emptyNameIndex: EditableStructureIndex = {
    id: "i1",
    name: "  ",
    columns: [],
    isUnique: false,
    isPrimary: false,
    filter: "",
    indexType: "",
    includedColumns: [],
    comment: "",
    markedForDrop: false,
  };
  const missingColIndex: EditableStructureIndex = {
    ...emptyNameIndex,
    id: "i2",
    name: "idx_missing",
    columns: ["nope"],
  };
  table.indexes = [emptyNameIndex, missingColIndex];
  const errors = validateDraftTable(table);
  assert.ok(errors.some((e) => e.includes("Table name is required")));
  assert.ok(errors.some((e) => e.includes("empty name")));
  assert.ok(errors.some((e) => e.includes("needs at least one column")));
  assert.ok(errors.some((e) => e.includes("missing column")));
});

test("draftTableToCreateSqlOptions shape", () => {
  const table = createDraftTable("users");
  table.indexes = [createDraftIndex("users", ["id"])];
  const options = draftTableToCreateSqlOptions(table, "postgres", "public");
  assert.equal(options.tableName, "users");
  assert.equal(options.schema, "public");
  assert.equal(options.databaseType, "postgres");
  assert.equal(options.columns.length, 1);
  assert.equal(options.indexes.length, 1);
  assert.deepEqual(options.foreignKeys, []);
});
