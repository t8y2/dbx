import assert from "node:assert/strict";
import { test } from "vitest";
import { canConfigureVisibleSchemasForTreeNode, isSchemaAware, supportsClearableQuerySchema, supportsDatabaseCreation, usesTreeSchemaMode } from "../../apps/desktop/src/lib/database/databaseCapabilities.ts";

test("TDengine uses database/catalog tree nodes without a schema layer", () => {
  assert.equal(isSchemaAware("tdengine"), false);
  assert.equal(usesTreeSchemaMode("tdengine"), false);
});

test("IoTDB keeps schema-qualified paths without showing a duplicate schema node", () => {
  assert.equal(isSchemaAware("iotdb"), true);
  assert.equal(usesTreeSchemaMode("iotdb"), false);
});

test("GoldenDB and Vastbase expose database creation", () => {
  assert.equal(supportsDatabaseCreation("goldendb"), true);
  assert.equal(supportsDatabaseCreation("vastbase"), true);
});

test("Vastbase keeps PostgreSQL-like schema filtering on database nodes", () => {
  assert.equal(isSchemaAware("vastbase"), true);
  assert.equal(usesTreeSchemaMode("vastbase"), true);
  assert.equal(canConfigureVisibleSchemasForTreeNode("vastbase", "database", "vastbase"), true);
  assert.equal(canConfigureVisibleSchemasForTreeNode("vastbase", "connection"), false);
});

test("visible schema menu capability preserves adjacent database families", () => {
  assert.equal(canConfigureVisibleSchemasForTreeNode("oracle", "connection"), true);
  assert.equal(canConfigureVisibleSchemasForTreeNode("dameng", "connection"), true);
  assert.equal(canConfigureVisibleSchemasForTreeNode("oceanbase-oracle", "connection"), false);
  assert.equal(canConfigureVisibleSchemasForTreeNode("postgres", "database", "app"), true);
  assert.equal(canConfigureVisibleSchemasForTreeNode("sqlserver", "database", "app"), true);
  assert.equal(canConfigureVisibleSchemasForTreeNode("mysql", "database", "app"), false);
});

test("only Oracle-compatible single-database schemas can be cleared from query tabs", () => {
  assert.equal(supportsClearableQuerySchema("oracle"), true);
  assert.equal(supportsClearableQuerySchema("dameng"), true);
  assert.equal(supportsClearableQuerySchema("oceanbase-oracle"), true);
  assert.equal(supportsClearableQuerySchema("mysql"), false);
  assert.equal(supportsClearableQuerySchema("postgres"), false);
  assert.equal(supportsClearableQuerySchema("sqlserver"), false);
  assert.equal(supportsClearableQuerySchema("jdbc"), false);
});
