import { strict as assert } from "node:assert";
import test from "node:test";
import { supportsObjectRename } from "../../apps/desktop/src/lib/objectRenameSql.ts";

test("recognizes object rename support for UI affordances", () => {
  assert.equal(supportsObjectRename("mysql", "TABLE"), true);
  assert.equal(supportsObjectRename("goldendb", "VIEW"), true);
  assert.equal(supportsObjectRename("postgres", "TABLE"), true);
  assert.equal(supportsObjectRename("oracle", "VIEW"), true);
  assert.equal(supportsObjectRename("sqlserver", "PROCEDURE"), true);
  assert.equal(supportsObjectRename("sqlite", "TABLE"), true);
  assert.equal(supportsObjectRename("sqlite", "VIEW"), false);
  assert.equal(supportsObjectRename("rqlite", "TABLE"), true);
  assert.equal(supportsObjectRename("rqlite", "VIEW"), false);
  assert.equal(supportsObjectRename("oracle", "FUNCTION"), false);
  assert.equal(supportsObjectRename("dameng", "PROCEDURE"), false);
  assert.equal(supportsObjectRename("mysql", "PROCEDURE"), false);
  assert.equal(supportsObjectRename("postgres", "FUNCTION"), false);
});
