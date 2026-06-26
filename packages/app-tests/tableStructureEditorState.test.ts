import assert from "node:assert/strict";
import { test } from "vitest";
import {
  applyManticoreDdlColumnExtras,
  buildStructureTargetLabel,
  canEditManticoreColumnProperties,
  combineDataTypeForDatabase,
  createColumnDrafts,
  createIndexDrafts,
  generateIndexName,
  generateUniqueIndexName,
  getColumnEditorControls,
  getDataTypeOptions,
  isProtectedManticoreIdColumn,
  normalizeDataTypeParams,
  parseExtraToColumnExtra,
  toColumnNames,
} from "../../apps/desktop/src/lib/tableStructureEditorState.ts";
import type { ColumnInfo, IndexInfo } from "../../apps/desktop/src/types/database.ts";

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
  const drafts = createColumnDrafts(columns, "mysql");

  assert.deepEqual(
    drafts.map((draft) => ({
      id: draft.id,
      name: draft.name,
      dataType: draft.dataType,
      isNullable: draft.isNullable,
      defaultValue: draft.defaultValue,
      comment: draft.comment,
      isPrimaryKey: draft.isPrimaryKey,
      extra: draft.extra,
      originalPosition: draft.originalPosition,
      markedForDrop: draft.markedForDrop,
      originalName: draft.original?.name,
    })),
    [
      {
        id: "existing:id",
        name: "id",
        dataType: "bigint",
        isNullable: false,
        defaultValue: "",
        comment: "identifier",
        isPrimaryKey: true,
        extra: { autoIncrement: true },
        originalPosition: 0,
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
        extra: {},
        originalPosition: 1,
        markedForDrop: false,
        originalName: "name",
      },
    ],
  );
});

test("normalizes PostgreSQL string default casts in editable column drafts", () => {
  const drafts = createColumnDrafts(
    [
      {
        name: "category",
        data_type: "character varying",
        is_nullable: true,
        column_default: "''::character varying",
        is_primary_key: false,
        extra: null,
        comment: null,
      },
      {
        name: "status",
        data_type: "user_status",
        is_nullable: true,
        column_default: "'active'::public.user_status",
        is_primary_key: false,
        extra: null,
        comment: null,
      },
      {
        name: "stock",
        data_type: "integer",
        is_nullable: true,
        column_default: "0",
        is_primary_key: false,
        extra: null,
        comment: null,
      },
    ],
    "postgres",
  );

  assert.equal(drafts[0].defaultValue, "''");
  assert.equal(drafts[0].original?.column_default, "''");
  assert.equal(drafts[1].defaultValue, "'active'::public.user_status");
  assert.equal(drafts[1].original?.column_default, "'active'::public.user_status");
  assert.equal(drafts[2].defaultValue, "0");
  assert.equal(drafts[2].original?.column_default, "0");
});

test("applies manticore column properties from ddl", () => {
  const manticoreColumns: ColumnInfo[] = [
    { name: "name", data_type: "string", is_nullable: true, column_default: null, is_primary_key: false, extra: null, comment: null },
    { name: "code", data_type: "string", is_nullable: true, column_default: null, is_primary_key: false, extra: null, comment: null },
    { name: "resource", data_type: "json", is_nullable: true, column_default: null, is_primary_key: false, extra: null, comment: null },
  ];
  const ddl = `CREATE TABLE materials (
name string indexed attribute,
code string attribute,
resource json secondary_index='1'
)`;

  const drafts = createColumnDrafts(applyManticoreDdlColumnExtras(manticoreColumns, ddl), "manticoresearch");

  assert.deepEqual(
    drafts.map((draft) => ({ name: draft.name, dataType: draft.dataType, extra: draft.extra })),
    [
      { name: "name", dataType: "string", extra: { manticoreIndexed: true, manticoreAttribute: true } },
      { name: "code", dataType: "string", extra: { manticoreAttribute: true } },
      { name: "resource", dataType: "json", extra: { manticoreSecondaryIndex: true } },
    ],
  );
});

test("parses MySQL extra string to ColumnExtra", () => {
  assert.deepEqual(parseExtraToColumnExtra("auto_increment", "mysql"), { autoIncrement: true });
  assert.deepEqual(parseExtraToColumnExtra("on update CURRENT_TIMESTAMP", "mysql"), {
    onUpdateCurrentTimestamp: true,
  });
  assert.deepEqual(parseExtraToColumnExtra("auto_increment on update current_timestamp", "mysql"), {
    autoIncrement: true,
    onUpdateCurrentTimestamp: true,
  });
  assert.deepEqual(parseExtraToColumnExtra(null, "mysql"), {});
  assert.deepEqual(parseExtraToColumnExtra("", "mysql"), {});
});

test("parses PostgreSQL extra string to ColumnExtra", () => {
  assert.deepEqual(parseExtraToColumnExtra("generated by default as identity", "postgres"), {
    identity: { generation: "BY DEFAULT" },
  });
  assert.deepEqual(parseExtraToColumnExtra("generated by default as identity", "opengauss"), {
    identity: { generation: "BY DEFAULT" },
  });
  assert.deepEqual(parseExtraToColumnExtra("generated by default as identity", "gaussdb"), {
    identity: { generation: "BY DEFAULT" },
  });
  assert.deepEqual(parseExtraToColumnExtra("GENERATED ALWAYS AS IDENTITY", "postgres"), {
    identity: { generation: "ALWAYS" },
  });
  assert.deepEqual(parseExtraToColumnExtra("generated always as identity (start with 10 increment by 2)", "postgres"), {
    identity: { generation: "ALWAYS", seed: 10, increment: 2 },
  });
});

test("parses SQL Server identity extra string to ColumnExtra", () => {
  assert.deepEqual(parseExtraToColumnExtra("identity(1,1)", "sqlserver"), {
    autoIncrement: true,
    identity: { seed: 1, increment: 1 },
  });
  assert.deepEqual(parseExtraToColumnExtra("IDENTITY(100, 5)", "sqlserver"), {
    autoIncrement: true,
    identity: { seed: 100, increment: 5 },
  });
});

test("parses Manticore Search text properties to ColumnExtra", () => {
  assert.deepEqual(parseExtraToColumnExtra("stored indexed", "manticoresearch"), {
    manticoreStored: true,
    manticoreIndexed: true,
  });
  assert.deepEqual(parseExtraToColumnExtra("attribute indexed", "manticoresearch"), {
    manticoreAttribute: true,
    manticoreIndexed: true,
  });
  assert.deepEqual(parseExtraToColumnExtra("secondary_index='1'", "manticoresearch"), {
    manticoreSecondaryIndex: true,
  });
});

test("creates editable index drafts and splits pasted column lists", () => {
  const drafts = createIndexDrafts(indexes);

  assert.deepEqual(
    drafts.map((draft) => ({
      id: draft.id,
      name: draft.name,
      columns: draft.columns,
      isUnique: draft.isUnique,
      isPrimary: draft.isPrimary,
      originalName: draft.original?.name,
    })),
    [
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
    ],
  );
  assert.equal(toColumnNames(["id", "name"]), "id, name");
});

test("generates conventional index names from table and columns", () => {
  assert.equal(generateIndexName("A", ["B"]), "A_B_IDX");
  assert.equal(generateIndexName("order item", ["customer-id", "created_at"]), "ORDER_ITEM_CUSTOMER_ID_CREATED_AT_IDX");
  assert.equal(generateIndexName("users", ["email"], 12), "USERS_EM_IDX");
});

test("generates unique index names when automatic name already exists", () => {
  assert.equal(generateUniqueIndexName("users", ["email"], ["USERS_EMAIL_IDX"]), "USERS_EMAIL_IDX_2");
  assert.equal(generateUniqueIndexName("users", ["email"], ["users_email_idx", "USERS_EMAIL_IDX_2"]), "USERS_EMAIL_IDX_3");
});

test("structure editor target label omits duplicate database and schema", () => {
  assert.equal(buildStructureTargetLabel("online-clickhouse", "testdb", "testdb", "users"), "online-clickhouse / testdb / users");
  assert.equal(buildStructureTargetLabel("online-postgres", "app", "public", "users"), "online-postgres / app / public / users");
});

test("normalizes temporal precision when combining data types", () => {
  assert.equal(combineDataTypeForDatabase("mysql", "timestamp", "255"), "timestamp");
  assert.equal(combineDataTypeForDatabase("mysql", "timestamp", "3"), "timestamp(3)");
  assert.equal(combineDataTypeForDatabase("mysql", "varchar", "255"), "varchar(255)");
  assert.equal(normalizeDataTypeParams("oracle", "timestamp", "9"), "9");
  assert.equal(normalizeDataTypeParams("oracle", "timestamp", "10"), "");
});

test("returns data type options for compatible table structure editors", () => {
  assert.deepEqual(getDataTypeOptions("dameng"), getDataTypeOptions("oracle"));
  assert.deepEqual(getDataTypeOptions("gaussdb"), getDataTypeOptions("postgres"));
  assert.deepEqual(getDataTypeOptions("doris"), getDataTypeOptions("mysql"));
  assert.equal(getDataTypeOptions("dameng").includes("varchar2"), true);
  assert.equal(getDataTypeOptions("sqlserver").includes("nvarchar"), true);
});

test("returns Xugu data type options", () => {
  const options = getDataTypeOptions("xugu");
  assert.equal(options.includes("INTEGER"), true);
  assert.equal(options.includes("VARCHAR"), true);
  assert.equal(options.includes("NUMERIC"), true);
  assert.equal(options.includes("INT"), true);
});

test("returns Manticore Search data type options", () => {
  assert.deepEqual(getDataTypeOptions("manticoresearch"), ["text", "string", "int", "bit", "bigint", "bool", "timestamp", "float", "json", "float_vector", "multi", "mva"]);
});

test("returns Manticore Search column editor controls", () => {
  assert.deepEqual(getColumnEditorControls("manticoresearch"), {
    length: true,
    nullable: false,
    primaryKey: false,
    defaultValue: false,
    comment: false,
  });
  assert.equal(getColumnEditorControls("mysql").nullable, true);
});

test("protects Manticore Search id column from destructive structure edits", () => {
  assert.equal(isProtectedManticoreIdColumn("manticoresearch", "id"), true);
  assert.equal(isProtectedManticoreIdColumn("manticoresearch", "ID"), true);
  assert.equal(isProtectedManticoreIdColumn("manticoresearch", "name"), false);
  assert.equal(isProtectedManticoreIdColumn("mysql", "id"), false);
});

test("allows Manticore Search column properties only before the column exists", () => {
  assert.equal(canEditManticoreColumnProperties("manticoresearch", false), true);
  assert.equal(canEditManticoreColumnProperties("manticoresearch", true), false);
  assert.equal(canEditManticoreColumnProperties("mysql", false), false);
});
