import assert from "node:assert/strict";
import { test } from "vitest";
import { buildAllDatabaseExportPlan } from "../../apps/desktop/src/lib/export/databaseExport.ts";

test("all-database export includes every schema for schema-aware databases", () => {
  const plan = buildAllDatabaseExportPlan({
    databases: ["app", "analytics"],
    schemaAware: true,
    schemasByDatabase: {
      app: ["public", "private"],
      analytics: ["reporting"],
    },
  });

  assert.deepEqual(plan, [
    { database: "app", schema: "public", fileStem: "app.public", displayName: "app.public" },
    { database: "app", schema: "private", fileStem: "app.private", displayName: "app.private" },
    { database: "analytics", schema: "reporting", fileStem: "analytics", displayName: "analytics" },
  ]);
});

test("all-database export uses the database as schema for non-schema-aware databases", () => {
  const plan = buildAllDatabaseExportPlan({
    databases: ["app", "analytics"],
    schemaAware: false,
    schemasByDatabase: {
      app: ["ignored"],
    },
  });

  assert.deepEqual(plan, [
    { database: "app", schema: "app", fileStem: "app", displayName: "app" },
    { database: "analytics", schema: "analytics", fileStem: "analytics", displayName: "analytics" },
  ]);
});

test("all-database export treats selected items as schemas for single-database types (dameng)", () => {
  // 达梦等单数据库架构：选中的"数据库"就是 schema 本身，不应做笛卡尔积展开
  const plan = buildAllDatabaseExportPlan({
    databases: ["COSIMULATION", "DATAMANAGE"],
    schemaAware: true,
    schemasByDatabase: {
      COSIMULATION: ["COSIMULATION", "DATAMANAGE", "MULTITEST"],
      DATAMANAGE: ["COSIMULATION", "DATAMANAGE", "MULTITEST"],
    },
    dbType: "dameng",
  });

  assert.deepEqual(plan, [
    { database: "", schema: "COSIMULATION", fileStem: "COSIMULATION", displayName: "COSIMULATION" },
    { database: "", schema: "DATAMANAGE", fileStem: "DATAMANAGE", displayName: "DATAMANAGE" },
  ]);
});

test("all-database export preserves real database for non-schema-aware single-database types (firebird)", () => {
  // firebird/questdb/access 是单库但非 schema-aware：不能短路成 database:"",
  // 否则空 database 会覆盖后端 db_config.database 破坏连接。
  const plan = buildAllDatabaseExportPlan({
    databases: ["inventory", "archive"],
    schemaAware: false,
    dbType: "firebird",
  });

  assert.deepEqual(plan, [
    { database: "inventory", schema: "inventory", fileStem: "inventory", displayName: "inventory" },
    { database: "archive", schema: "archive", fileStem: "archive", displayName: "archive" },
  ]);
});
