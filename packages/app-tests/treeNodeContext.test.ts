import assert from "node:assert/strict";
import { test } from "vitest";
import { hasTreeNodeDatabaseContext, normalizeCataloglessDatabaseNodes, treeNodeSchemaCachePrefix } from "../../apps/desktop/src/lib/treeNodeContext.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";

test("treats empty database string as a valid catalogless context", () => {
  assert.equal(hasTreeNodeDatabaseContext({ database: "" }), true);
  assert.equal(hasTreeNodeDatabaseContext({ database: "app" }), true);
  assert.equal(hasTreeNodeDatabaseContext({}), false);
});

test("builds cache prefixes for catalogless database and schema nodes", () => {
  const databaseNode: TreeNode = {
    id: "conn:",
    label: "tree.defaultDatabase",
    type: "database",
    connectionId: "conn",
    database: "",
  };
  const schemaNode: TreeNode = {
    id: "conn::APP",
    label: "APP",
    type: "schema",
    connectionId: "conn",
    database: "",
    schema: "APP",
  };

  assert.equal(treeNodeSchemaCachePrefix(databaseNode), "conn::");
  assert.equal(treeNodeSchemaCachePrefix(schemaNode), "conn::APP:");
});

test("normalizes legacy blank cached catalogless database labels", () => {
  const nodes = normalizeCataloglessDatabaseNodes([
    {
      id: "conn:",
      label: "",
      type: "database",
      connectionId: "conn",
      database: "",
      children: [],
    },
  ]);

  assert.equal(nodes[0].label, "tree.defaultDatabase");
});
