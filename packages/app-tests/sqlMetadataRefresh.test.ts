import assert from "node:assert/strict";
import { test } from "vitest";
import { sqlMetadataRefreshScope, sqlMetadataRefreshTarget } from "../../apps/desktop/src/lib/sqlMetadataRefresh.ts";

test("database DDL refreshes the connection database list", () => {
  assert.equal(sqlMetadataRefreshScope("CREATE DATABASE app;"), "connection");
  assert.deepEqual(sqlMetadataRefreshTarget("DROP DATABASE app;"), { scope: "connection" });
});

test("schema DDL refreshes the selected database tree", () => {
  assert.equal(sqlMetadataRefreshScope("drop schema public cascade;"), "database");
  assert.deepEqual(sqlMetadataRefreshTarget("CREATE SCHEMA analytics;"), { scope: "database" });
});

test("object DDL refreshes the selected database tree", () => {
  assert.equal(sqlMetadataRefreshScope("CREATE TABLE users (id int);"), "database");
  assert.equal(sqlMetadataRefreshScope("CREATE TEMP TABLE scratch (id int);"), "database");
  assert.equal(sqlMetadataRefreshScope("CREATE MATERIALIZED VIEW daily_users AS SELECT 1;"), "database");
  assert.equal(sqlMetadataRefreshScope("ALTER TABLE users ADD COLUMN name text;"), "database");
  assert.equal(sqlMetadataRefreshScope("DROP VIEW active_users;"), "database");
  assert.equal(sqlMetadataRefreshScope("CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE SQL;"), "database");
});

test("qualified object DDL refreshes the matching schema node", () => {
  assert.deepEqual(sqlMetadataRefreshTarget("CREATE TABLE public.users (id int);"), {
    scope: "database",
    schema: "public",
  });
  assert.deepEqual(sqlMetadataRefreshTarget('ALTER TABLE "Sales".orders ADD COLUMN name text;'), {
    scope: "database",
    schema: "Sales",
  });
  assert.deepEqual(sqlMetadataRefreshTarget("DROP VIEW `reporting`.active_users;"), {
    scope: "database",
    schema: "reporting",
  });
  assert.deepEqual(sqlMetadataRefreshTarget("CREATE INDEX idx_users_email ON public.users (email);"), {
    scope: "database",
    schema: "public",
  });
});

test("unqualified object DDL can use the active schema as the refresh target", () => {
  assert.deepEqual(sqlMetadataRefreshTarget("ALTER TABLE users ADD COLUMN name text;", "public"), {
    scope: "database",
    schema: "public",
  });
  assert.deepEqual(sqlMetadataRefreshTarget("CREATE SCHEMA analytics;", "public"), { scope: "database" });
});

test("multiple object DDL schemas fall back to refreshing the database tree", () => {
  assert.deepEqual(sqlMetadataRefreshTarget("CREATE TABLE public.users (id int); CREATE TABLE audit.events (id int);"), { scope: "database" });
});

test("data-only SQL does not refresh metadata trees", () => {
  assert.equal(sqlMetadataRefreshScope("SELECT * FROM users;"), "none");
  assert.equal(sqlMetadataRefreshScope("INSERT INTO users VALUES (1);"), "none");
  assert.equal(sqlMetadataRefreshScope("TRUNCATE TABLE users;"), "none");
  assert.deepEqual(sqlMetadataRefreshTarget("SELECT * FROM users;"), { scope: "none" });
});
