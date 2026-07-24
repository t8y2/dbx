import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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

test("ConnectionDialog database categories stay exhaustive", () => {
  const dialogPath = join(dirname(fileURLToPath(import.meta.url)), "../../apps/desktop/src/components/connection/ConnectionDialog.vue");
  const source = readFileSync(dialogPath, "utf8");
  const optionsMatch = source.match(/const dbOptions: DbOption\[] = \[([\s\S]*?)\];/);
  const categoriesMatch = source.match(/const dbCategoryDefinitions: Array<\{[\s\S]*?\}> = \[([\s\S]*?)\];/);
  assert.ok(optionsMatch, "dbOptions not found");
  assert.ok(categoriesMatch, "dbCategoryDefinitions not found");

  const optionValues = [...optionsMatch[1].matchAll(/value:\s*"([^"]+)"/g)].map((match) => match[1]);
  const categoryBlocks = [...categoriesMatch[1].matchAll(/optionValues:\s*\[([^\]]*)\]/g)].map((match) =>
    [...match[1].matchAll(/"([^"]+)"/g)].map((valueMatch) => valueMatch[1]),
  );

  assert.doesNotThrow(() => assertCompleteDatabaseCategories(optionValues, categoryBlocks));
  assert.ok(optionValues.includes("rabbitmq"), "rabbitmq must remain in dbOptions");
  assert.ok(categoryBlocks.some((values) => values.includes("rabbitmq")), "rabbitmq must remain categorized");
});
