import assert from "node:assert/strict";
import { test } from "vitest";
import { canEditTableStructure, getTableStructureCapabilities } from "../../apps/desktop/src/lib/tableStructureCapabilities.ts";

test("sqlite-family and duckdb do not support table comments", () => {
  for (const dbType of ["sqlite", "rqlite", "duckdb"] as const) {
    const caps = getTableStructureCapabilities(dbType);
    assert.equal(caps.comment, false, `${dbType} should not support comments`);
    assert.equal(caps.createTable, true, `${dbType} should still support creating tables`);
  }
});

test("postgres-like databases expose safe structure editing capabilities", () => {
  for (const dbType of ["postgres", "gaussdb", "kwdb", "opengauss", "highgo", "vastbase", "kingbase"] as const) {
    const caps = getTableStructureCapabilities(dbType);
    assert.equal(caps.dialect, "postgres", `${dbType} should reuse postgres DDL`);
    assert.equal(caps.createTable, true, `${dbType} should create tables`);
    assert.equal(caps.addColumn, true, `${dbType} should add columns`);
    assert.equal(caps.dropColumn, true, `${dbType} should drop columns`);
    assert.equal(caps.renameColumn, true, `${dbType} should rename columns`);
    assert.equal(caps.alterExistingColumn, true, `${dbType} should edit existing columns`);
    assert.equal(caps.comment, true, `${dbType} should support comments`);
    assert.equal(caps.createIndex, true, `${dbType} should create indexes`);
    assert.equal(caps.dropIndex, true, `${dbType} should drop indexes`);
    assert.equal(caps.rebuildIndex, true, `${dbType} should rebuild indexes`);
    assert.equal(caps.indexFilter, true, `${dbType} should support filtered indexes`);
    assert.equal(canEditTableStructure(dbType), true);
  }
});

test("mysql-like databases expose index rebuild and type capabilities", () => {
  for (const dbType of ["mysql", "doris", "starrocks", "goldendb", "sundb"] as const) {
    const caps = getTableStructureCapabilities(dbType);
    assert.equal(caps.dialect, "mysql", `${dbType} should reuse mysql DDL`);
    assert.equal(caps.createIndex, true);
    assert.equal(caps.dropIndex, true);
    assert.equal(caps.rebuildIndex, true);
    assert.equal(caps.indexType, true);
    assert.equal(caps.reorderColumn, true);
    assert.equal(canEditTableStructure(dbType), true);
  }
});

test("gbase 8a exposes limited mysql-compatible structure editing capabilities", () => {
  const caps = getTableStructureCapabilities("gbase");
  assert.equal(caps.dialect, "mysql");
  assert.equal(caps.createTable, true);
  assert.equal(caps.addColumn, true);
  assert.equal(caps.dropColumn, true);
  assert.equal(caps.renameColumn, true);
  assert.equal(caps.alterExistingColumn, false);
  assert.equal(caps.createIndex, false);
  assert.equal(caps.dropIndex, false);
  assert.equal(caps.rebuildIndex, false);
  assert.equal(caps.comment, false);
  assert.equal(canEditTableStructure("gbase"), true);
});

test("redshift reuses postgres column DDL but keeps indexes disabled", () => {
  const caps = getTableStructureCapabilities("redshift");
  assert.equal(caps.dialect, "postgres");
  assert.equal(caps.createTable, true);
  assert.equal(caps.addColumn, true);
  assert.equal(caps.dropColumn, true);
  assert.equal(caps.renameColumn, true);
  assert.equal(caps.alterExistingColumn, true);
  assert.equal(caps.comment, true);
  assert.equal(caps.createIndex, false);
  assert.equal(caps.dropIndex, false);
  assert.equal(caps.rebuildIndex, false);
  assert.equal(caps.indexFilter, false);
  assert.equal(canEditTableStructure("redshift"), true);
});

test("oracle-like databases expose oracle-compatible structure editing capabilities", () => {
  for (const dbType of ["oracle", "dameng", "oceanbase-oracle"] as const) {
    const caps = getTableStructureCapabilities(dbType);
    assert.equal(caps.dialect, "oracle", `${dbType} should reuse oracle DDL`);
    assert.equal(caps.createTable, true);
    assert.equal(caps.addColumn, true);
    assert.equal(caps.dropColumn, true);
    assert.equal(caps.renameColumn, true);
    assert.equal(caps.alterExistingColumn, true);
    assert.equal(caps.comment, true);
    assert.equal(caps.createIndex, true);
    assert.equal(caps.dropIndex, true);
    assert.equal(caps.rebuildIndex, true);
    assert.equal(caps.reorderColumn, false);
    assert.equal(canEditTableStructure(dbType), true);
  }
});

test("limited analytic engines can open the editor for supported operations only", () => {
  const clickhouse = getTableStructureCapabilities("clickhouse");
  assert.equal(clickhouse.dialect, "clickhouse");
  assert.equal(clickhouse.createTable, true);
  assert.equal(clickhouse.addColumn, true);
  assert.equal(clickhouse.dropColumn, true);
  assert.equal(clickhouse.renameColumn, true);
  assert.equal(clickhouse.alterExistingColumn, true);
  assert.equal(clickhouse.alterType, true);
  assert.equal(clickhouse.alterNullability, true);
  assert.equal(clickhouse.alterDefault, true);
  assert.equal(clickhouse.reorderColumn, true);
  assert.equal(clickhouse.comment, true);
  assert.equal(clickhouse.createIndex, false);
  assert.equal(clickhouse.rebuildIndex, false);
  assert.equal(canEditTableStructure("clickhouse"), true);
});

test("informix exposes conservative structure editing capabilities", () => {
  const caps = getTableStructureCapabilities("informix");
  assert.equal(caps.dialect, "informix");
  assert.equal(caps.createTable, true);
  assert.equal(caps.addColumn, true);
  assert.equal(caps.dropColumn, true);
  assert.equal(caps.renameColumn, true);
  assert.equal(caps.alterExistingColumn, true);
  assert.equal(caps.comment, false);
  assert.equal(caps.createIndex, true);
  assert.equal(caps.dropIndex, true);
  assert.equal(caps.rebuildIndex, true);
  assert.equal(caps.indexType, false);
  assert.equal(caps.alterPrimaryKey, false);
  assert.equal(canEditTableStructure("informix"), true);
});

test("unsupported non-relational databases do not open the structure editor", () => {
  for (const dbType of ["redis", "mongodb", "elasticsearch", "manticoresearch", "neo4j", undefined] as const) {
    const caps = getTableStructureCapabilities(dbType);
    assert.equal(caps.dialect, "unsupported");
    assert.equal(canEditTableStructure(dbType), false);
  }
});
