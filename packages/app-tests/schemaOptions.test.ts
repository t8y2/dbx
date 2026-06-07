import test from "node:test";
import assert from "node:assert/strict";
import { hasSchemaOptionsCacheEntry } from "../../apps/desktop/src/composables/useSchemaOptions.ts";

test("treats an empty schema option list as a loaded cache entry", () => {
  const options = {
    "conn:db": [],
  };

  assert.equal(hasSchemaOptionsCacheEntry(options, "conn:db"), true);
  assert.equal(hasSchemaOptionsCacheEntry(options, "conn:other"), false);
});
