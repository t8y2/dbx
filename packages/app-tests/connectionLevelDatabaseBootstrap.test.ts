import { strict as assert } from "node:assert";
import { test } from "vitest";
import { canExecuteWithoutSelectedDatabase, requiresSqlFileTargetDatabaseSelection, supportsConnectionLevelDatabaseBootstrap } from "../../apps/desktop/src/lib/connectionLevelDatabaseBootstrap.ts";
import type { ConnectionConfig } from "../../apps/desktop/src/types/database.ts";

function connection(dbType: ConnectionConfig["db_type"], driverProfile?: string): Pick<ConnectionConfig, "db_type" | "driver_profile"> {
  return {
    db_type: dbType,
    driver_profile: driverProfile,
  };
}

test("supports MySQL-compatible connection-level bootstrap targets", () => {
  assert.equal(supportsConnectionLevelDatabaseBootstrap(connection("mysql")), true);
  assert.equal(supportsConnectionLevelDatabaseBootstrap(connection("doris")), true);
  assert.equal(supportsConnectionLevelDatabaseBootstrap(connection("starrocks")), true);
  assert.equal(supportsConnectionLevelDatabaseBootstrap(connection("goldendb")), true);
  assert.equal(supportsConnectionLevelDatabaseBootstrap(connection("mysql", "selectdb")), true);
  assert.equal(supportsConnectionLevelDatabaseBootstrap(connection("mysql", "oceanbase")), true);
  assert.equal(supportsConnectionLevelDatabaseBootstrap(connection("mysql", "OceanBase")), true);
  assert.equal(supportsConnectionLevelDatabaseBootstrap(connection("mysql", "SelectDB")), true);
});

test("excludes non-MySQL bootstrap targets", () => {
  assert.equal(supportsConnectionLevelDatabaseBootstrap(connection("postgres")), false);
  assert.equal(supportsConnectionLevelDatabaseBootstrap(connection("manticoresearch")), false);
  assert.equal(supportsConnectionLevelDatabaseBootstrap(connection("oceanbase-oracle")), false);
});

test("allows install scripts that create and switch databases before table DDL", () => {
  const sql = "SET NAMES utf8mb4; DROP DATABASE IF EXISTS app_db; CREATE DATABASE app_db; USE app_db; CREATE TABLE users(id INT)";
  assert.equal(canExecuteWithoutSelectedDatabase(connection("mysql"), sql), true);
});

test("blocks scripts that never establish database context", () => {
  const sql = "CREATE DATABASE app_db; CREATE TABLE users(id INT)";
  assert.equal(canExecuteWithoutSelectedDatabase(connection("mysql"), sql), false);
});

test("blocks malformed USE statements that trail into other SQL", () => {
  const sql = "CREATE DATABASE app_db; USE app_db SELECT 1; CREATE TABLE users(id INT)";
  assert.equal(canExecuteWithoutSelectedDatabase(connection("mysql"), sql), false);
});

test("accepts escaped MySQL-compatible identifiers in USE statements", () => {
  const sql = "CREATE DATABASE [tenant]]01]; -- switch tenant\nUSE [tenant]]01]; CREATE TABLE users(id INT)";
  assert.equal(canExecuteWithoutSelectedDatabase(connection("mysql"), sql), true);
});

test("SQL file execution still requires an explicit database for non-MySQL targets", () => {
  assert.equal(requiresSqlFileTargetDatabaseSelection(connection("postgres"), true), true);
  assert.equal(requiresSqlFileTargetDatabaseSelection(connection("mysql"), true), false);
  assert.equal(requiresSqlFileTargetDatabaseSelection(connection("mysql"), false), true);
});
