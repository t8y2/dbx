import assert from "node:assert/strict";
import { test } from "vitest";
import { getTableMetadataCapabilities } from "../../apps/desktop/src/lib/tableMetadataCapabilities.ts";

test("manticore search exposes secondary indexes but hides relational constraints", () => {
  assert.deepEqual(getTableMetadataCapabilities("manticoresearch"), {
    columns: true,
    indexes: true,
    foreignKeys: false,
    triggers: false,
    ddl: true,
  });
});
