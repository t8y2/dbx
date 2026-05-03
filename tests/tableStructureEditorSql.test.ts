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

test("PostgreSQL index with INCLUDE clause", () => {
  const result = buildTableStructureChangeSql({
    databaseType: "postgres",
    schema: "public",
    tableName: "orders",
    columns: [],
    indexes: [
      index({
        id: "new",
        name: "idx_orders_status",
        columns: ["status"],
        includedColumns: ["total", "created_at"],
      }),
    ],
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.statements, [
    'CREATE INDEX "idx_orders_status" ON "public"."orders" ("status") INCLUDE ("total", "created_at");',
  ]);
});

test("PostgreSQL index with USING clause (index type)", () => {
  const result = buildTableStructureChangeSql({
    databaseType: "postgres",
    schema: "public",
    tableName: "docs",
    columns: [],
    indexes: [
      index({
        id: "new",
        name: "idx_docs_body",
        columns: ["body"],
        indexType: "GIN",
      }),
    ],
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.statements, [
    'CREATE INDEX "idx_docs_body" ON "public"."docs" USING GIN ("body");',
  ]);
});

test("PostgreSQL index with WHERE filter", () => {
  const result = buildTableStructureChangeSql({
    databaseType: "postgres",
    schema: "public",
    tableName: "users",
    columns: [],
    indexes: [
      index({
        id: "new",
        name: "idx_users_active",
        columns: ["email"],
        filter: "deleted_at IS NULL",
      }),
    ],
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.statements, [
    'CREATE INDEX "idx_users_active" ON "public"."users" ("email") WHERE deleted_at IS NULL;',
  ]);
});

test("PostgreSQL index with COMMENT", () => {
  const result = buildTableStructureChangeSql({
    databaseType: "postgres",
    schema: "public",
    tableName: "users",
    columns: [],
    indexes: [
      index({
        id: "new",
        name: "idx_users_email",
        columns: ["email"],
        comment: "Fast lookup by email",
      }),
    ],
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.statements, [
    'CREATE INDEX "idx_users_email" ON "public"."users" ("email");',
    "COMMENT ON INDEX \"idx_users_email\" IS 'Fast lookup by email';",
  ]);
});

test("PostgreSQL index with single quote in comment is escaped", () => {
  const result = buildTableStructureChangeSql({
    databaseType: "postgres",
    schema: "public",
    tableName: "users",
    columns: [],
    indexes: [
      index({
        id: "new",
        name: "idx_users_email",
        columns: ["email"],
        comment: "User's primary email",
      }),
    ],
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.statements, [
    'CREATE INDEX "idx_users_email" ON "public"."users" ("email");',
    "COMMENT ON INDEX \"idx_users_email\" IS 'User''s primary email';",
  ]);
});

test("PostgreSQL index with all options combined (unique + type + include + filter + comment)", () => {
  const result = buildTableStructureChangeSql({
    databaseType: "postgres",
    schema: "public",
    tableName: "orders",
    columns: [],
    indexes: [
      index({
        id: "new",
        name: "idx_orders_covering",
        columns: ["user_id", "status"],
        isUnique: true,
        indexType: "BTREE",
        includedColumns: ["total"],
        filter: "status = 'active'",
        comment: "Covering index for active orders",
      }),
    ],
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.statements, [
    'CREATE UNIQUE INDEX "idx_orders_covering" ON "public"."orders" USING BTREE ("user_id", "status") INCLUDE ("total") WHERE status = \'active\';',
    "COMMENT ON INDEX \"idx_orders_covering\" IS 'Covering index for active orders';",
  ]);
});

test("SQL Server index with type prefix", () => {
  const result = buildTableStructureChangeSql({
    databaseType: "sqlserver",
    schema: "dbo",
    tableName: "logs",
    columns: [],
    indexes: [
      index({
        id: "new",
        name: "idx_logs_message",
        columns: ["message"],
        indexType: "CLUSTERED",
      }),
    ],
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.statements, [
    "CREATE CLUSTERED INDEX [idx_logs_message] ON [dbo].[logs] ([message]);",
  ]);
});

test("SQL Server index with INCLUDE clause", () => {
  const result = buildTableStructureChangeSql({
    databaseType: "sqlserver",
    schema: "dbo",
    tableName: "orders",
    columns: [],
    indexes: [
      index({
        id: "new",
        name: "idx_orders_status",
        columns: ["status"],
        includedColumns: ["total", "created_at"],
      }),
    ],
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.statements, [
    "CREATE INDEX [idx_orders_status] ON [dbo].[orders] ([status]) INCLUDE ([total], [created_at]);",
  ]);
});

test("SQL Server index with type + include combined", () => {
  const result = buildTableStructureChangeSql({
    databaseType: "sqlserver",
    schema: "dbo",
    tableName: "orders",
    columns: [],
    indexes: [
      index({
        id: "new",
        name: "idx_orders_covering",
        columns: ["user_id"],
        indexType: "NONCLUSTERED",
        includedColumns: ["total", "status"],
      }),
    ],
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.statements, [
    "CREATE NONCLUSTERED INDEX [idx_orders_covering] ON [dbo].[orders] ([user_id]) INCLUDE ([total], [status]);",
  ]);
});

test("MySQL index does not emit USING or type prefix, but INCLUDE and WHERE are passed through", () => {
  const result = buildTableStructureChangeSql({
    databaseType: "mysql",
    tableName: "orders",
    columns: [],
    indexes: [
      index({
        id: "new",
        name: "idx_orders_status",
        columns: ["status"],
        indexType: "BTREE",
        includedColumns: ["total"],
        filter: "deleted = 0",
        comment: "Some comment",
      }),
    ],
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.statements, [
    "CREATE INDEX `idx_orders_status` ON `orders` (`status`) INCLUDE (`total`) WHERE deleted = 0;",
  ]);
});

test("SQLite index with filter (partial index)", () => {
  const result = buildTableStructureChangeSql({
    databaseType: "sqlite",
    tableName: "users",
    columns: [],
    indexes: [
      index({
        id: "new",
        name: "idx_users_active",
        columns: ["email"],
        filter: "deleted_at IS NULL",
      }),
    ],
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.statements, [
    'CREATE INDEX "idx_users_active" ON "users" ("email") WHERE deleted_at IS NULL;',
  ]);
});

test("index with empty name and columns produces warnings and no statements", () => {
  const result = buildTableStructureChangeSql({
    databaseType: "postgres",
    schema: "public",
    tableName: "users",
    columns: [],
    indexes: [
      index({ id: "empty", name: "", columns: [] }),
    ],
  });

  assert.deepEqual(result.warnings, [
    'Index name cannot be empty.',
    'Index "(new)" needs at least one column.',
  ]);
  assert.deepEqual(result.statements, []);
});
