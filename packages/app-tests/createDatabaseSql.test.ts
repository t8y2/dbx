import assert from "node:assert/strict";
import { test } from "vitest";
import { duckDbAttachedDatabaseNameFromPath, uniqueDuckDbAttachedDatabaseName, supportsCreateDatabaseCharset } from "../../apps/desktop/src/lib/createDatabaseSql.ts";

test("recognizes MySQL-compatible driver profiles", () => {
  assert.equal(supportsCreateDatabaseCharset("mysql", "oceanbase"), true);
  assert.equal(supportsCreateDatabaseCharset("mysql", "doris"), true);
  assert.equal(supportsCreateDatabaseCharset("postgres", undefined), false);
});

test("derives a stable DuckDB attached database name from a file path", () => {
  assert.equal(duckDbAttachedDatabaseNameFromPath("/Users/me/sales.duckdb"), "sales");
  assert.equal(duckDbAttachedDatabaseNameFromPath("C:\\data\\2026 report.db"), "2026_report");
  assert.equal(duckDbAttachedDatabaseNameFromPath("/tmp/.duckdb"), "duckdb_database");
});

test("deduplicates DuckDB attached database aliases", () => {
  assert.equal(uniqueDuckDbAttachedDatabaseName("analytics", ["main", "analytics"]), "analytics_2");
  assert.equal(uniqueDuckDbAttachedDatabaseName("analytics", ["analytics", "analytics_2"]), "analytics_3");
});
