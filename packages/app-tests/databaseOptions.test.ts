import assert from "node:assert/strict";
import test from "node:test";
import { databaseOptionsForConnection } from "../../apps/desktop/src/composables/useDatabaseOptions.ts";

test("tree-schema connections include the default database when no catalogs are returned", () => {
  assert.deepEqual(databaseOptionsForConnection([], { db_type: "jdbc" }), [""]);
});

test("non tree-schema connections keep an empty database option list", () => {
  assert.deepEqual(databaseOptionsForConnection([], { db_type: "mysql" }), []);
});

test("database options preserve returned catalogs when available", () => {
  assert.deepEqual(databaseOptionsForConnection(["app", "analytics"], { db_type: "jdbc" }), ["app", "analytics"]);
});
