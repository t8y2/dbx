import { strict as assert } from "node:assert";
import test from "node:test";
import { DBX_ROWID_COLUMN } from "../src/lib/tableEditing.ts";
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

test("builds SQL Server first page query with schema-aware brackets", () => {
  const sql = buildTableSelectSql({
    databaseType: "sqlserver",
    schema: "dbo",
    tableName: "accounts",
    whereInput: "where id = 1",
    limit: 25,
    primaryKeys: ["id"],
  });

  assert.equal(
    sql,
    "SELECT * FROM [dbo].[accounts] WHERE (id = 1) ORDER BY [id] ASC OFFSET 0 ROWS FETCH NEXT 25 ROWS ONLY",
  );
});

test("builds SQL Server later pages with OFFSET and FETCH", () => {
  const sql = buildTableSelectSql({
    databaseType: "sqlserver",
    schema: "sales",
    tableName: "orders",
    primaryKeys: ["order_id"],
    limit: 50,
    offset: 100,
  });

  assert.equal(sql, "SELECT * FROM [sales].[orders] ORDER BY [order_id] ASC OFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY");
});

test("builds SQL Server pages with fallback order columns when there is no primary key", () => {
  const sql = buildTableSelectSql({
    databaseType: "sqlserver",
    schema: "dbo",
    tableName: "logs",
    fallbackOrderColumns: ["created_at"],
    limit: 50,
    offset: 50,
  });

  assert.equal(sql, "SELECT * FROM [dbo].[logs] ORDER BY [created_at] ASC OFFSET 50 ROWS FETCH NEXT 50 ROWS ONLY");
});

test("builds Oracle table data queries with ROWID for keyless editing", () => {
  const sql = buildTableSelectSql({
    databaseType: "oracle",
    schema: "DBXTEST",
    tableName: "DBX_LOAD_TABLE_006",
    primaryKeys: [DBX_ROWID_COLUMN],
    includeRowId: true,
    limit: 100,
  });

  assert.equal(
    sql,
    `SELECT ROWIDTOCHAR(t.ROWID) AS "__DBX_ROWID", t.* FROM "DBXTEST"."DBX_LOAD_TABLE_006" t ORDER BY t.ROWID ASC FETCH FIRST 100 ROWS ONLY`,
  );
});
