import { strict as assert } from "node:assert";
import { test } from "vitest";
import { filterDatabaseNamesForConnection, filterVisibleDatabaseNames, isSystemDatabaseName, canSaveVisibleDatabaseSelection, normalizeVisibleDatabaseSelection, visibleDatabaseFilterIsEnabled } from "../../apps/desktop/src/lib/visibleDatabases.ts";

test("undefined visible database filter keeps every database", () => {
  assert.deepEqual(filterVisibleDatabaseNames(["app", "analytics"], undefined), ["app", "analytics"]);
  assert.equal(visibleDatabaseFilterIsEnabled(undefined), false);
});

test("configured visible database filter keeps selected databases in source order", () => {
  assert.deepEqual(filterVisibleDatabaseNames(["app", "analytics", "billing"], ["billing", "app"]), ["app", "billing"]);
  assert.equal(visibleDatabaseFilterIsEnabled(["billing", "app"]), true);
});

test("empty configured visible database filter hides every database", () => {
  assert.deepEqual(filterVisibleDatabaseNames(["app", "analytics"], []), []);
  assert.equal(visibleDatabaseFilterIsEnabled([]), true);
});

test("empty visible database selection cannot be saved", () => {
  assert.equal(canSaveVisibleDatabaseSelection(["app"]), true);
  assert.equal(canSaveVisibleDatabaseSelection([]), false);
});

test("normalizes selected database names against fresh database names", () => {
  assert.deepEqual(normalizeVisibleDatabaseSelection(["billing", "missing", "app", "app"], ["app", "billing"]), ["billing", "app"]);
});

test("mysql system databases are hidden by default but can be explicitly selected", () => {
  const databases = ["app", "information_schema", "mysql", "performance_schema", "sys"];
  assert.deepEqual(filterDatabaseNamesForConnection(databases, { db_type: "mysql" }), ["app"]);
  assert.deepEqual(filterDatabaseNamesForConnection(databases, { db_type: "manticoresearch" }), ["app"]);
  assert.deepEqual(filterDatabaseNamesForConnection(databases, { db_type: "mysql", visible_databases: ["app", "sys"] }), ["app", "sys"]);
  assert.equal(isSystemDatabaseName("mysql", "performance_schema"), true);
  assert.equal(isSystemDatabaseName("manticoresearch", "information_schema"), true);
  assert.equal(isSystemDatabaseName("postgres", "information_schema"), false);
});

test("gbase8s does not inherit base gbase system database filtering", () => {
  const databases = ["app", "information_schema", "mysql", "performance_schema", "sys"];
  assert.deepEqual(filterDatabaseNamesForConnection(databases, { db_type: "gbase" }), ["app"]);
  assert.deepEqual(filterDatabaseNamesForConnection(databases, { db_type: "gbase", driver_profile: "gbase8s" }), databases);
});

test("system database detection is registered per database type", () => {
  assert.deepEqual(filterDatabaseNamesForConnection(["default", "system"], { db_type: "clickhouse" }), ["default"]);
  assert.deepEqual(filterDatabaseNamesForConnection(["master", "app", "tempdb"], { db_type: "sqlserver" }), ["app"]);
  assert.equal(isSystemDatabaseName("clickhouse", "INFORMATION_SCHEMA"), true);
  assert.equal(isSystemDatabaseName("sqlserver", "msdb"), true);
});

test("system database registry covers common database families", () => {
  assert.deepEqual(filterDatabaseNamesForConnection(["template0", "app"], { db_type: "postgres" }), ["app"]);
  assert.deepEqual(filterDatabaseNamesForConnection(["admin", "shop", "local"], { db_type: "mongodb" }), ["shop"]);
  assert.deepEqual(filterDatabaseNamesForConnection(["SYS", "HR", "SYSTEM"], { db_type: "oracle" }), ["HR"]);
  assert.deepEqual(filterDatabaseNamesForConnection(["_SYS_BIC", "SALES"], { db_type: "saphana" }), ["SALES"]);
  assert.deepEqual(filterDatabaseNamesForConnection(["system_schema", "app"], { db_type: "cassandra" }), ["app"]);
  assert.deepEqual(filterDatabaseNamesForConnection(["system", "neo4j"], { db_type: "neo4j" }), ["neo4j"]);
  assert.deepEqual(filterDatabaseNamesForConnection(["SNOWFLAKE", "ANALYTICS"], { db_type: "snowflake" }), ["ANALYTICS"]);
});
