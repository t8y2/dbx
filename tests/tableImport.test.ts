import { strict as assert } from "node:assert";
import test from "node:test";
import {
  autoMapImportColumns,
  normalizeImportColumnName,
} from "../src/lib/tableImport.ts";

test("normalizes import column names for matching", () => {
  assert.equal(normalizeImportColumnName(" User ID "), "user id");
  assert.equal(normalizeImportColumnName("user_id"), "user id");
  assert.equal(normalizeImportColumnName("USER-ID"), "user id");
});

test("auto maps source columns to matching target columns and skips unknown columns", () => {
  const mapping = autoMapImportColumns(
    ["id", "Name", "created-at", "ignored"],
    ["user_id", "name", "created_at"],
  );

  assert.deepEqual(mapping, {
    id: "",
    Name: "name",
    "created-at": "created_at",
    ignored: "",
  });
});
