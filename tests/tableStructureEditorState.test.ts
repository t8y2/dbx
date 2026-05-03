import assert from "node:assert/strict";
import test from "node:test";
import {
  createColumnDrafts,
  createIndexDrafts,
  toColumnNames,
} from "../src/lib/tableStructureEditorState.ts";
import type { ColumnInfo, IndexInfo } from "../src/types/database.ts";

const columns: ColumnInfo[] = [
  {
    name: "id",
    data_type: "bigint",
    is_nullable: false,
    column_default: null,
    is_primary_key: true,
    extra: "auto_increment",
    comment: "identifier",
  },
  {
    name: "name",
    data_type: "varchar(120)",
    is_nullable: true,
    column_default: "'guest'",
    is_primary_key: false,
    extra: null,
    comment: null,
  },
];

const indexes: IndexInfo[] = [
  { name: "PRIMARY", columns: ["id"], is_unique: true, is_primary: true },
  { name: "idx_name", columns: ["name"], is_unique: false, is_primary: false },
];

test("creates editable column drafts from column metadata", () => {
  const drafts = createColumnDrafts(columns);

  assert.deepEqual(drafts.map((draft) => ({
    id: draft.id,
    name: draft.name,
    dataType: draft.dataType,
    isNullable: draft.isNullable,
    defaultValue: draft.defaultValue,
    comment: draft.comment,
    isPrimaryKey: draft.isPrimaryKey,
    markedForDrop: draft.markedForDrop,
    originalName: draft.original?.name,
  })), [
    {
      id: "existing:id",
      name: "id",
      dataType: "bigint",
      isNullable: false,
      defaultValue: "",
      comment: "identifier",
      isPrimaryKey: true,
      markedForDrop: false,
      originalName: "id",
    },
    {
      id: "existing:name",
      name: "name",
      dataType: "varchar(120)",
      isNullable: true,
      defaultValue: "'guest'",
      comment: "",
      isPrimaryKey: false,
      markedForDrop: false,
      originalName: "name",
    },
  ]);
});

test("creates editable index drafts and splits pasted column lists", () => {
  const drafts = createIndexDrafts(indexes);

  assert.deepEqual(drafts.map((draft) => ({
    id: draft.id,
    name: draft.name,
    columns: draft.columns,
    isUnique: draft.isUnique,
    isPrimary: draft.isPrimary,
    originalName: draft.original?.name,
  })), [
    {
      id: "existing:PRIMARY",
      name: "PRIMARY",
      columns: ["id"],
      isUnique: true,
      isPrimary: true,
      originalName: "PRIMARY",
    },
    {
      id: "existing:idx_name",
      name: "idx_name",
      columns: ["name"],
      isUnique: false,
      isPrimary: false,
      originalName: "idx_name",
    },
  ]);
  assert.equal(toColumnNames(["id", "name"]), "id, name");
});
