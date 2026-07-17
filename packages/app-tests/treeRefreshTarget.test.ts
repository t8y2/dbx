import assert from "node:assert/strict";
import { test } from "vitest";
import { findDatabaseTreeNode } from "../../apps/desktop/src/lib/sidebar/treeRefreshTarget.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";

test("finds database refresh targets inside grouped sidebar trees", () => {
  const target: TreeNode = {
    id: "conn-1:app",
    label: "app",
    type: "database",
    connectionId: "conn-1",
    database: "app",
  };
  const nodes: TreeNode[] = [
    {
      id: "group-1",
      label: "Production",
      type: "connection-group",
      children: [
        {
          id: "conn-1",
          label: "mysql",
          type: "connection",
          connectionId: "conn-1",
          children: [target],
        },
      ],
    },
  ];

  assert.equal(findDatabaseTreeNode(nodes, "conn-1", "app"), target);
});

test("returns null when the target database node is not loaded", () => {
  assert.equal(findDatabaseTreeNode([], "conn-1", "app"), null);
});
