import { strict as assert } from "node:assert";
import test from "node:test";
import { buildTableSelectSql } from "../src/lib/tableSelectSql.ts";

test("builds a MySQL table WHERE query from search input", () => {
  const sql = buildTableSelectSql({
    databaseType: "mysql",
    tableName: "users",
    primaryKeys: ["id"],
    whereInput: "where status = 'active'",
    limit: 100,
  });

  assert.equal(sql, "SELECT * FROM `users` WHERE (status = 'active') ORDER BY `id` ASC LIMIT 100;");
});

test("builds a schema-qualified PostgreSQL table WHERE query", () => {
  const sql = buildTableSelectSql({
    databaseType: "postgres",
    schema: "public",
    tableName: "orders",
    whereInput: "WHERE amount > 10",
    limit: 50,
    offset: 100,
  });

  assert.equal(sql, 'SELECT * FROM "public"."orders" WHERE (amount > 10) LIMIT 50 OFFSET 100;');
});

test("builds SQL Server WHERE query with TOP", () => {
  const sql = buildTableSelectSql({
    databaseType: "sqlserver",
    schema: "dbo",
    tableName: "accounts",
    whereInput: "where id = 1",
    limit: 25,
  });

  assert.equal(sql, 'SELECT TOP 25 * FROM "dbo"."accounts" WHERE (id = 1)');
});
