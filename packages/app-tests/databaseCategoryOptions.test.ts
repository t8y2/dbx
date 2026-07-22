import assert from "node:assert/strict";
import { test } from "vitest";
import { assertCompleteDatabaseCategories, databaseSelectionForCategory } from "../../apps/desktop/src/lib/connection/databaseCategoryOptions.ts";

test("database categories cover every option exactly once", () => {
  assert.doesNotThrow(() => assertCompleteDatabaseCategories(["mysql", "redis", "kafka"], [["mysql"], ["redis", "kafka"]]));
  assert.throws(() => assertCompleteDatabaseCategories(["mysql", "redis"], [["mysql"]]), /missing=redis/);
  assert.throws(() => assertCompleteDatabaseCategories(["mysql"], [["mysql"], ["mysql"]]), /duplicates=mysql/);
  assert.throws(() => assertCompleteDatabaseCategories(["mysql"], [["mysql", "unknown"]]), /unknown=unknown/);
});

test("database category changes keep only visible selections", () => {
  assert.equal(databaseSelectionForCategory("mysql", ["mysql", "postgres"]), "mysql");
  assert.equal(databaseSelectionForCategory("mysql", ["questdb", "tdengine"]), "questdb");
  assert.equal(databaseSelectionForCategory("mysql", []), undefined);
});
