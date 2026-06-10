import assert from "node:assert/strict";
import { test } from "vitest";
import { databaseOptionsForConnection } from "../../apps/desktop/src/composables/useDatabaseOptions.ts";

test("tree-schema connections include the default database when no catalogs are returned", () => {
  assert.deepEqual(databaseOptionsForConnection([], { db_type: "saphana" }), [""]);
});

test("non tree-schema connections keep an empty database option list", () => {
  assert.deepEqual(databaseOptionsForConnection([], { db_type: "mysql" }), []);
});

test("database options preserve returned catalogs when available", () => {
  assert.deepEqual(databaseOptionsForConnection(["app", "analytics"], { db_type: "jdbc" }), ["app", "analytics"]);
});

test("database options respect visible database filters", () => {
  assert.deepEqual(
    databaseOptionsForConnection(["app", "analytics", "billing"], {
      db_type: "mysql",
      visible_databases: ["billing", "missing"],
    }),
    ["billing"],
  );
});

test("redis database options respect visible database filters", () => {
  assert.deepEqual(
    databaseOptionsForConnection(["0", "1", "2"], {
      db_type: "redis",
      visible_databases: ["2"],
    }),
    ["2"],
  );
});
