import assert from "node:assert/strict";
import { test } from "vitest";
import type { ConnectionConfig } from "../src/connections.js";
import type { ColumnInfo, TableInfo } from "../src/database.js";
import { buildSchemaContext, formatSchemaContext } from "../src/schema-context.js";

const config: ConnectionConfig = {
  id: "pg",
  name: "analytics",
  db_type: "postgres",
  host: "localhost",
  port: 5432,
  username: "app",
  password: "",
  database: "warehouse",
  ssh_enabled: false,
  ssl: false,
};

const tableRows: TableInfo[] = [
  { name: "users", type: "BASE TABLE" },
  { name: "orders", type: "BASE TABLE" },
  { name: "events", type: "BASE TABLE" },
];

const columns: Record<string, ColumnInfo[]> = {
  users: [
    { name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, comment: null },
    { name: "email", data_type: "text", is_nullable: false, column_default: null, is_primary_key: false, comment: "Login email" },
  ],
  orders: [
    { name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, comment: null },
    { name: "user_id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: false, comment: null },
  ],
};

test("builds schema context for requested tables", async () => {
  const context = await buildSchemaContext(
    {
      listTables: async () => tableRows,
      describeTable: async (_config, table) => columns[table] ?? [],
    },
    config,
    { tables: ["users", "orders"], maxTables: 5 },
  );

  assert.equal(context.connection, "analytics");
  assert.deepEqual(
    context.tables.map((table) => table.name),
    ["users", "orders"],
  );
  assert.equal(context.tables[0].columns[0].is_primary_key, true);
});

test("limits schema context when no table list is provided", async () => {
  const context = await buildSchemaContext(
    {
      listTables: async () => tableRows,
      describeTable: async (_config, table) => columns[table] ?? [],
    },
    config,
    { maxTables: 2 },
  );

  assert.deepEqual(
    context.tables.map((table) => table.name),
    ["users", "orders"],
  );
});

test("formats schema context as compact markdown", async () => {
  const context = await buildSchemaContext(
    {
      listTables: async () => tableRows,
      describeTable: async (_config, table) => columns[table] ?? [],
    },
    config,
    { tables: ["users"] },
  );

  const markdown = formatSchemaContext(context);

  assert.match(markdown, /Connection: analytics/);
  assert.match(markdown, /## users/);
  assert.match(markdown, /id integer NOT NULL PK/);
  assert.match(markdown, /email text NOT NULL -- Login email/);
});
