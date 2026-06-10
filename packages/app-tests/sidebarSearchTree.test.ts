import { strict as assert } from "node:assert";
import { test } from "vitest";
import { filterSidebarSearchRootsByConnectionState, filterSidebarTree } from "../../apps/desktop/src/lib/sidebarSearchTree.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";

test("preserves loaded table children when the table itself matches search", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:db",
      label: "app",
      type: "database",
      connectionId: "conn",
      database: "app",
      isExpanded: true,
      children: [
        {
          id: "conn:db:orders",
          label: "orders",
          type: "table",
          connectionId: "conn",
          database: "app",
          isExpanded: true,
          children: [
            {
              id: "conn:db:orders:__columns",
              label: "tree.columns",
              type: "group-columns",
              connectionId: "conn",
              database: "app",
              tableName: "orders",
              isExpanded: true,
              children: [
                {
                  id: "conn:db:orders:__columns:id",
                  label: "id",
                  type: "column",
                  connectionId: "conn",
                  database: "app",
                  tableName: "orders",
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  const filtered = filterSidebarTree(nodes, "orders", new Set());

  const table = filtered[0]?.children?.[0];
  assert.equal(table?.label, "orders");
  assert.equal(table?.children?.[0]?.label, "tree.columns");
  assert.equal(table?.children?.[0]?.children?.[0]?.label, "id");
});

test("preserves loaded schema children when the database itself matches search", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:hdi",
      label: "hdi",
      type: "database",
      connectionId: "conn",
      database: "hdi",
      isExpanded: true,
      children: [
        {
          id: "conn:hdi:public",
          label: "public",
          type: "schema",
          connectionId: "conn",
          database: "hdi",
          schema: "public",
          isExpanded: false,
          children: [],
        },
      ],
    },
  ];

  const filtered = filterSidebarTree(nodes, "hdi", new Set());

  assert.equal(filtered[0]?.label, "hdi");
  assert.equal(filtered[0]?.children?.[0]?.label, "public");
});

test("search scope excludes non-selected node self matches", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:1",
      label: "orders-conn",
      type: "connection",
      connectionId: "conn",
      isExpanded: true,
      children: [
        {
          id: "conn:1:db",
          label: "orders_db",
          type: "database",
          connectionId: "conn",
          database: "orders_db",
          isExpanded: true,
          children: [
            {
              id: "conn:1:db:table",
              label: "customers",
              type: "table",
              connectionId: "conn",
              database: "orders_db",
            },
          ],
        },
      ],
    },
  ];

  const filtered = filterSidebarTree(nodes, "orders", new Set(), new Set(["table"]));

  assert.equal(filtered.length, 0);
});

test("connection search results stay visible before connecting", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:1",
      label: "Orders local",
      type: "connection",
      connectionId: "conn:1",
      isExpanded: false,
      children: [],
    },
    {
      id: "conn:1:db",
      label: "orders",
      type: "database",
      connectionId: "conn:1",
      database: "orders",
    },
  ];

  const filtered = filterSidebarSearchRootsByConnectionState(nodes, new Set());

  assert.deepEqual(
    filtered.map((node) => node.id),
    ["conn:1"],
  );
});
