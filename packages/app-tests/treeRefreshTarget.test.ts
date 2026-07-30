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

test("keeps same-named databases isolated by catalog", () => {
  const hive: TreeNode = {
    id: "conn-1:doris-catalog:hive:sales",
    label: "sales",
    type: "database",
    connectionId: "conn-1",
    catalog: "hive",
    database: "sales",
  };
  const iceberg: TreeNode = {
    id: "conn-1:doris-catalog:iceberg:sales",
    label: "sales",
    type: "database",
    connectionId: "conn-1",
    catalog: "iceberg",
    database: "sales",
  };
  const internal: TreeNode = {
    id: "conn-1:sales",
    label: "sales",
    type: "database",
    connectionId: "conn-1",
    database: "sales",
  };
  const nodes: TreeNode[] = [
    {
      id: "conn-1",
      label: "StarRocks",
      type: "connection",
      connectionId: "conn-1",
      children: [internal, { id: "catalog-hive", label: "hive", type: "doris-catalog", connectionId: "conn-1", catalog: "hive", children: [hive] }, { id: "catalog-iceberg", label: "iceberg", type: "doris-catalog", connectionId: "conn-1", catalog: "iceberg", children: [iceberg] }],
    },
  ];

  assert.equal(findDatabaseTreeNode(nodes, "conn-1", "sales"), internal);
  assert.equal(findDatabaseTreeNode(nodes, "conn-1", "sales", "hive"), hive);
  assert.equal(findDatabaseTreeNode(nodes, "conn-1", "sales", "iceberg"), iceberg);
});
