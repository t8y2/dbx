import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildSqlCompletionItems,
  type SqlCompletionColumn,
  type SqlCompletionTable,
} from "../src/lib/sqlCompletion.ts";

const tables: SqlCompletionTable[] = [
  { name: "users", schema: "public", type: "table" },
  { name: "user_profiles", schema: "public", type: "table" },
  { name: "orders", schema: "public", type: "table" },
];

const columnsByTable = new Map<string, SqlCompletionColumn[]>([
  ["public.users", [
    { name: "id", table: "users", schema: "public", dataType: "bigint" },
    { name: "name", table: "users", schema: "public", dataType: "varchar" },
    { name: "email", table: "users", schema: "public", dataType: "varchar" },
  ]],
  ["public.orders", [
    { name: "id", table: "orders", schema: "public", dataType: "bigint" },
    { name: "user_id", table: "orders", schema: "public", dataType: "bigint" },
    { name: "status", table: "orders", schema: "public", dataType: "varchar" },
  ]],
]);

test("suggests SQL keywords for generic keyword input", () => {
  const items = buildSqlCompletionItems("sel", 3, {
    tables,
    columnsByTable,
  });

  assert.equal(items[0]?.label, "SELECT");
  assert.equal(items[0]?.type, "keyword");
});

test("suggests matching table names after FROM", () => {
  const sql = "select * from us";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.deepEqual(
    items.slice(0, 2).map((item) => item.label),
    ["users", "user_profiles"],
  );
});

test("suggests columns for an explicit alias qualifier", () => {
  const sql = "select u. from public.users u";
  const cursor = "select u.".length;
  const items = buildSqlCompletionItems(sql, cursor, {
    tables,
    columnsByTable,
  });

  assert.deepEqual(
    items.map((item) => item.label),
    ["id", "name", "email"],
  );
  assert.ok(items.every((item) => item.type === "column"));
});

test("suggests columns from referenced tables in select list", () => {
  const sql = "select na from public.users u join public.orders o on u.id = o.user_id";
  const cursor = "select na".length;
  const items = buildSqlCompletionItems(sql, cursor, {
    tables,
    columnsByTable,
  });

  assert.equal(items[0]?.label, "name");
  assert.equal(items[0]?.type, "column");
});
