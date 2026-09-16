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

const columns: ColumnInfo[] = [col({ name: "id", data_type: "integer", is_primary_key: true, extra: "auto_increment" }), col({ name: "name", data_type: "varchar" }), col({ name: "created_at", data_type: "timestamp" })];

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

test("builds a MetricsQL range query for VictoriaMetrics metrics", () => {
  assert.equal(buildTableSelectTemplate({ databaseType: "victoriametrics", tableName: "flag" }), '{__name__="flag"}[1h]');
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

test("builds GaussDB M templates with the detected backtick identifier mode", () => {
  const options = {
    databaseType: "gaussdb" as const,
    identifierQuote: "`",
    schema: "app_schema",
    tableName: "order",
    columns: [col({ name: "id", data_type: "integer", is_primary_key: true }), col({ name: "DisplayName", data_type: "varchar" })],
  };

  assert.equal(buildTableSelectTemplate(options), "SELECT id, `DisplayName`\nFROM app_schema.`order`;");
  assert.equal(buildTableInsertTemplate(options), "INSERT INTO app_schema.`order` (id, `DisplayName`)\nVALUES (0, 'DisplayName_value');");
  assert.equal(buildTableUpdateTemplate(options), "UPDATE app_schema.`order`\nSET `DisplayName` = 'DisplayName_value'\nWHERE id = 0;");
  assert.equal(buildTableDeleteTemplate(options), "DELETE FROM app_schema.`order`\nWHERE id = 0;");
});

test("preserves the Phoenix schema in all SQL templates", () => {
  const options = {
    databaseType: "jdbc" as const,
    driverProfile: "phoenix",
    identifierQuote: '"',
    schema: "APP",
    tableName: "USERS",
    columns: [col({ name: "ID", data_type: "integer", is_primary_key: true }), col({ name: "NAME", data_type: "varchar" })],
  };

  assert.equal(buildTableSelectTemplate(options), 'SELECT "ID", "NAME"\nFROM "APP"."USERS";');
  assert.equal(buildTableInsertTemplate(options), `INSERT INTO "APP"."USERS" ("ID", "NAME")\nVALUES (0, 'NAME_value');`);
  assert.equal(buildTableUpdateTemplate(options), `UPDATE "APP"."USERS"\nSET "NAME" = 'NAME_value'\nWHERE "ID" = 0;`);
  assert.equal(buildTableDeleteTemplate(options), `DELETE FROM "APP"."USERS"\nWHERE "ID" = 0;`);
});

test("respects includeDatabaseName=false for schema-aware engines (#9110)", () => {
  // Oracle's schema qualifier is the "database name" on schema-aware engines;
  // turning the setting off must drop it, not just on MySQL-style engines.
  const sql = buildTableSelectTemplate({
    databaseType: "oracle",
    identifierQuote: `"`,
    schema: "SYSTEM",
    includeDatabaseName: false,
    quoteIdentifiers: false,
    tableName: "AQ$_INTERNET_AGENTS",
    columns: [{ name: "ID" }],
  } as Parameters<typeof buildTableSelectTemplate>[0]);
  assert.equal(sql, "SELECT ID\nFROM AQ$_INTERNET_AGENTS;");
});

test("respects includeDatabaseName=false on quoted-identifier connections (#9110)", () => {
  // The identifierQuote early-return paths (JDBC/agent connections) must
  // honor the toggle too, not just the native schema-aware branch.
  const base = {
    databaseType: "postgres" as const,
    identifierQuote: '"',
    schema: "public",
    tableName: "Users",
    columns,
  };
  assert.equal(buildTableSelectTemplate(base), 'SELECT id, name, created_at\nFROM public."Users";');
  assert.equal(buildTableSelectTemplate({ ...base, includeDatabaseName: false }), 'SELECT id, name, created_at\nFROM "Users";');
});

test("keeps the schema qualifier for databases that require it and the default (both settings on)", () => {
  // Default settings: schema stays.
  const defaultSql = buildTableSelectTemplate({
    databaseType: "oracle",
    identifierQuote: `"`,
    schema: "SYSTEM",
    includeDatabaseName: true,
    quoteIdentifiers: true,
    tableName: "T1",
    columns: [{ name: "ID" }],
  } as Parameters<typeof buildTableSelectTemplate>[0]);
  assert.equal(defaultSql, 'SELECT "ID"\nFROM "SYSTEM"."T1";');
});

test("quoteIdentifiers=false emits bare column names in SELECT templates", () => {
  const sql = buildTableSelectTemplate({
    databaseType: "mysql",
    schema: undefined,
    database: "shopdb",
    includeDatabaseName: true,
    quoteIdentifiers: false,
    tableName: "orders",
    columns: [{ name: "id" }, { name: "amount" }],
  } as Parameters<typeof buildTableSelectTemplate>[0]);
  assert.equal(sql, "SELECT id, amount\nFROM shopdb.orders;");
});
