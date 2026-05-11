import { strict as assert } from "node:assert";
import test from "node:test";
import { buildEditableObjectSourceSql, objectSourceEditTabTitle } from "../src/lib/objectSourceEditor.ts";

test("SQL Server object source opens as CREATE OR ALTER", () => {
  const sql = buildEditableObjectSourceSql({
    databaseType: "sqlserver",
    objectType: "PROCEDURE",
    schema: "dbo",
    name: "usp_demo",
    source: "CREATE PROCEDURE dbo.usp_demo AS SELECT 1;",
  });

  assert.equal(sql, "CREATE OR ALTER PROCEDURE dbo.usp_demo AS SELECT 1;");
});

test("SQL Server existing CREATE OR ALTER source is preserved", () => {
  const sql = buildEditableObjectSourceSql({
    databaseType: "sqlserver",
    objectType: "VIEW",
    schema: "dbo",
    name: "vw_demo",
    source: "CREATE OR ALTER VIEW dbo.vw_demo AS SELECT 1 AS id;",
  });

  assert.equal(sql, "CREATE OR ALTER VIEW dbo.vw_demo AS SELECT 1 AS id;");
});

test("Postgres view body opens as CREATE OR REPLACE VIEW", () => {
  const sql = buildEditableObjectSourceSql({
    databaseType: "postgres",
    objectType: "VIEW",
    schema: "public",
    name: "active users",
    source: " SELECT id, name FROM users WHERE active ",
  });

  assert.equal(sql, 'CREATE OR REPLACE VIEW "public"."active users" AS\nSELECT id, name FROM users WHERE active;');
});

test("object source edit tab title is stable per schema and object", () => {
  assert.equal(objectSourceEditTabTitle("dbo", "usp_demo"), "Edit source - dbo.usp_demo");
  assert.equal(objectSourceEditTabTitle(undefined, "usp_demo"), "Edit source - usp_demo");
});
