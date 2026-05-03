import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTableStructureChangeSql,
  type EditableStructureColumn,
  type EditableStructureIndex,
} from "../src/lib/tableStructureEditorSql.ts";

function column(overrides: Partial<EditableStructureColumn>): EditableStructureColumn {
  return {
    id: overrides.id ?? "col",
    name: overrides.name ?? "name",
    dataType: overrides.dataType ?? "varchar(255)",
    isNullable: overrides.isNullable ?? true,
    defaultValue: overrides.defaultValue ?? "",
    comment: overrides.comment ?? "",
    isPrimaryKey: overrides.isPrimaryKey ?? false,
    original: overrides.original,
    markedForDrop: overrides.markedForDrop ?? false,
  };
}

function index(overrides: Partial<EditableStructureIndex>): EditableStructureIndex {
  return {
    id: overrides.id ?? "idx",
    name: overrides.name ?? "idx_name",
    columns: overrides.columns ?? ["name"],
    isUnique: overrides.isUnique ?? false,
    isPrimary: overrides.isPrimary ?? false,
    filter: overrides.filter ?? "",
    indexType: overrides.indexType ?? "",
    includedColumns: overrides.includedColumns ?? [],
    comment: overrides.comment ?? "",
    original: overrides.original,
    markedForDrop: overrides.markedForDrop ?? false,
  };
}

test("builds MySQL column and index change statements", () => {
  const result = buildTableStructureChangeSql({
    databaseType: "mysql",
    tableName: "users",
    columns: [
      column({
        id: "name",
        name: "display_name",
        dataType: "varchar(120)",
        isNullable: false,
        defaultValue: "'guest'",
        comment: "Shown name",
        original: {
          name: "name",
          data_type: "varchar(80)",
          is_nullable: true,
          column_default: null,
          is_primary_key: false,
          extra: null,
          comment: "",
        },
      }),
      column({ id: "email", name: "email", dataType: "varchar(255)", isNullable: false }),
      column({
        id: "legacy",
        name: "legacy",
        markedForDrop: true,
        original: {
          name: "legacy",
          data_type: "text",
          is_nullable: true,
          column_default: null,
          is_primary_key: false,
          extra: null,
        },
      }),
    ],
    indexes: [
      index({
        id: "old",
        name: "idx_old",
        markedForDrop: true,
        original: { name: "idx_old", columns: ["name"], is_unique: false, is_primary: false },
      }),
      index({ id: "email_idx", name: "uniq_users_email", columns: ["email"], isUnique: true }),
    ],
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.statements, [
    "ALTER TABLE `users` CHANGE COLUMN `name` `display_name` varchar(120) NOT NULL DEFAULT 'guest' COMMENT 'Shown name';",
    "ALTER TABLE `users` ADD COLUMN `email` varchar(255) NOT NULL;",
    "ALTER TABLE `users` DROP COLUMN `legacy`;",
    "DROP INDEX `idx_old` ON `users`;",
    "CREATE UNIQUE INDEX `uniq_users_email` ON `users` (`email`);",
  ]);
});

test("builds PostgreSQL rename, type, default, comment, and index statements", () => {
  const result = buildTableStructureChangeSql({
    databaseType: "postgres",
    schema: "public",
    tableName: "accounts",
    columns: [
      column({
        id: "status",
        name: "account_status",
        dataType: "text",
        isNullable: false,
        defaultValue: "'active'",
        comment: "Current status",
        original: {
          name: "status",
          data_type: "varchar",
          is_nullable: true,
          column_default: null,
          is_primary_key: false,
          extra: null,
          comment: "",
        },
      }),
    ],
    indexes: [
      index({ id: "new", name: "idx_accounts_status", columns: ["account_status"] }),
    ],
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.statements, [
    "ALTER TABLE \"public\".\"accounts\" RENAME COLUMN \"status\" TO \"account_status\";",
    "ALTER TABLE \"public\".\"accounts\" ALTER COLUMN \"account_status\" TYPE text;",
    "ALTER TABLE \"public\".\"accounts\" ALTER COLUMN \"account_status\" SET NOT NULL;",
    "ALTER TABLE \"public\".\"accounts\" ALTER COLUMN \"account_status\" SET DEFAULT 'active';",
    "COMMENT ON COLUMN \"public\".\"accounts\".\"account_status\" IS 'Current status';",
    "CREATE INDEX \"idx_accounts_status\" ON \"public\".\"accounts\" (\"account_status\");",
  ]);
});

test("warns when SQLite cannot safely alter existing column attributes", () => {
  const result = buildTableStructureChangeSql({
    databaseType: "sqlite",
    tableName: "notes",
    columns: [
      column({
        id: "title",
        name: "title",
        dataType: "text",
        isNullable: false,
        original: {
          name: "title",
          data_type: "varchar(100)",
          is_nullable: true,
          column_default: null,
          is_primary_key: false,
          extra: null,
        },
      }),
      column({ id: "body", name: "body", dataType: "text", isNullable: true }),
    ],
    indexes: [],
  });

  assert.deepEqual(result.statements, [
    "ALTER TABLE \"notes\" ADD COLUMN \"body\" text;",
  ]);
  assert.deepEqual(result.warnings, [
    "SQLite cannot safely alter existing column \"title\" without rebuilding the table.",
  ]);
});

test("quotes SQL Server table, column, and index names with brackets", () => {
  const result = buildTableStructureChangeSql({
    databaseType: "sqlserver",
    schema: "dbo",
    tableName: "users",
    columns: [
      column({ id: "email", name: "email", dataType: "nvarchar(255)", isNullable: false }),
    ],
    indexes: [
      index({ id: "idx", name: "idx_users_email", columns: ["email"] }),
    ],
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.statements, [
    "ALTER TABLE [dbo].[users] ADD [email] nvarchar(255) NOT NULL;",
    "CREATE INDEX [idx_users_email] ON [dbo].[users] ([email]);",
  ]);
});
