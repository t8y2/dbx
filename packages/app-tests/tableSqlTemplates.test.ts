import { strict as assert } from "node:assert";
import { test } from "vitest";
import type { ColumnInfo } from "../../apps/desktop/src/types/database.ts";
import { buildTableDeleteTemplate, buildTableInsertTemplate, buildTableSelectTemplate, buildTableUpdateTemplate } from "../../apps/desktop/src/lib/table/tableSqlTemplates.ts";

function col(overrides: Partial<ColumnInfo> & { name: string; data_type: string }): ColumnInfo {
  return {
    is_nullable: true,
    column_default: null,
    is_primary_key: false,
    extra: null,
    ...overrides,
  };
}

const columns: ColumnInfo[] = [
  col({ name: "id", data_type: "integer", is_primary_key: true, extra: "auto_increment" }),
  col({ name: "name", data_type: "varchar" }),
  col({ name: "created_at", data_type: "timestamp" }),
];

test("builds SELECT template with explicit table columns", () => {
  assert.equal(
    buildTableSelectTemplate({
      databaseType: "postgres",
      schema: "public",
      tableName: "users",
      columns,
    }),
    'SELECT "id", "name", "created_at"\nFROM "public"."users";',
  );
});

test("builds INSERT template without auto generated columns", () => {
  assert.equal(
    buildTableInsertTemplate({
      databaseType: "mysql",
      tableName: "users",
      columns,
    }),
    "INSERT INTO `users` (`name`, `created_at`)\nVALUES ('name_value', CURRENT_TIMESTAMP);",
  );
});

test("builds UPDATE template with primary key WHERE clause", () => {
  assert.equal(
    buildTableUpdateTemplate({
      databaseType: "postgres",
      schema: "public",
      tableName: "users",
      columns,
    }),
    'UPDATE "public"."users"\nSET "name" = \'name_value\',\n    "created_at" = CURRENT_TIMESTAMP\nWHERE "id" = 0;',
  );
});

test("builds DELETE template with primary key WHERE clause", () => {
  assert.equal(
    buildTableDeleteTemplate({
      databaseType: "postgres",
      schema: "public",
      tableName: "users",
      columns,
    }),
    'DELETE FROM "public"."users"\nWHERE "id" = 0;',
  );
});

test("builds DELETE template with TODO WHERE clause when no primary key exists", () => {
  assert.equal(
    buildTableDeleteTemplate({
      databaseType: "sqlite",
      tableName: "audit",
      columns: [col({ name: "message", data_type: "text" })],
    }),
    'DELETE FROM "audit"\nWHERE /* TODO: add WHERE clause */;',
  );
});
