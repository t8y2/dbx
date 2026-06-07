import { strict as assert } from "node:assert";
import test from "node:test";
import { filterDatabaseOptions } from "../../apps/desktop/src/lib/databaseOptionSearch.ts";

test("returns all database options when the search query is empty", () => {
  assert.deepEqual(filterDatabaseOptions(["app", "analytics"], ""), ["app", "analytics"]);
  assert.deepEqual(filterDatabaseOptions(["app", "analytics"], "   "), ["app", "analytics"]);
});

test("filters database options case-insensitively", () => {
  assert.deepEqual(filterDatabaseOptions(["app", "Analytics", "billing"], "ANA"), ["Analytics"]);
});

test("matches redis-style display labels", () => {
  assert.deepEqual(
    filterDatabaseOptions(["0", "1", "12"], "db1", (database) => `db${database}`),
    ["1", "12"],
  );
});
