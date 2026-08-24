import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { assertCompleteDatabaseCategories, databaseSelectionForCategory } from "../../apps/desktop/src/lib/connection/databaseCategoryOptions.ts";
import { JDBC_PRODUCT_PROFILES } from "../../apps/desktop/src/lib/database/jdbcProductProfiles.ts";
import { CONNECTION_PICKER_OPTIONS } from "../../apps/desktop/src/types/generated/connectionProfiles.ts";

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

test("ConnectionDialog database categories stay exhaustive", () => {
  const dialogPath = join(dirname(fileURLToPath(import.meta.url)), "../../apps/desktop/src/components/connection/ConnectionDialog.vue");
  const source = readFileSync(dialogPath, "utf8");
  const optionValues = [...CONNECTION_PICKER_OPTIONS.map((option) => option.value), ...JDBC_PRODUCT_PROFILES.map((profile) => profile.id)];
  const categories = new Set([...CONNECTION_PICKER_OPTIONS.map((option) => option.category), ...JDBC_PRODUCT_PROFILES.map((profile) => profile.category)]);
  const categoryBlocks = [...categories].map((category) => [...CONNECTION_PICKER_OPTIONS.filter((option) => option.category === category).map((option) => option.value), ...JDBC_PRODUCT_PROFILES.filter((profile) => profile.category === category).map((profile) => profile.id)]);

  assert.doesNotThrow(() => assertCompleteDatabaseCategories(optionValues, categoryBlocks));
  assert.match(source, /\.\.\.CONNECTION_PICKER_OPTIONS/);
  assert.match(source, /\.\.\.CONNECTION_PROFILES/);
  assert.match(source, /jdbcProductProfileIdsForCategory\(key\)/);
  assert.match(source, /\.\.\.jdbcProductIconTypes\(\)/);
  assert.ok(optionValues.includes("rabbitmq"), "rabbitmq must remain in dbOptions");
  assert.ok(
    categoryBlocks.some((values) => values.includes("rabbitmq")),
    "rabbitmq must remain categorized",
  );
  assert.ok(optionValues.includes("uxdb"), "uxdb must remain in dbOptions");
  assert.ok(
    categoryBlocks.some((values) => values.includes("uxdb")),
    "uxdb must remain categorized",
  );
});
