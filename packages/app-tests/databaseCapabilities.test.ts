import assert from "node:assert/strict";
import { test } from "vitest";
import { isSchemaAware, supportsDatabaseCreation, usesTreeSchemaMode } from "../../apps/desktop/src/lib/databaseCapabilities.ts";

test("TDengine uses database/catalog tree nodes without a schema layer", () => {
  assert.equal(isSchemaAware("tdengine"), false);
  assert.equal(usesTreeSchemaMode("tdengine"), false);
});

test("IoTDB keeps schema-qualified paths without showing a duplicate schema node", () => {
  assert.equal(isSchemaAware("iotdb"), true);
  assert.equal(usesTreeSchemaMode("iotdb"), false);
});

test("GoldenDB and Vastbase expose database creation", () => {
  assert.equal(supportsDatabaseCreation("goldendb"), true);
  assert.equal(supportsDatabaseCreation("vastbase"), true);
});
