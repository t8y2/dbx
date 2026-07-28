import { strict as assert } from "node:assert";
import { test } from "vitest";
import { filterSidebarSearchRootsByConnectionState, filterSidebarTree } from "../../apps/desktop/src/lib/sidebar/sidebarSearchTree.ts";
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

test("preserves loaded MongoDB collection children when the database itself matches search", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:analytics",
      label: "analytics",
      type: "mongo-db",
      connectionId: "conn",
      database: "analytics",
      isExpanded: true,
      children: [
        {
          id: "conn:analytics:__gridfs",
          label: "tree.gridfs",
          type: "mongo-gridfs",
          connectionId: "conn",
          database: "analytics",
          isExpanded: false,
        },
        {
          id: "conn:analytics:orders",
          label: "orders",
          type: "mongo-collection",
          connectionId: "conn",
          database: "analytics",
          isExpanded: false,
        },
      ],
    },
  ];

  const filtered = filterSidebarTree(nodes, "analytics", new Set());

  assert.equal(filtered[0]?.label, "analytics");
  assert.deepEqual(
    filtered[0]?.children?.map((child) => child.type),
    ["mongo-gridfs", "mongo-collection"],
  );
  assert.equal(filtered[0]?.children?.[1]?.label, "orders");
});

test("preserves loaded MongoDB collection groups when the collection itself matches search", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:analytics",
      label: "analytics",
      type: "mongo-db",
      connectionId: "conn",
      database: "analytics",
      isExpanded: true,
      children: [
        {
          id: "conn:analytics:orders",
          label: "orders",
          type: "mongo-collection",
          connectionId: "conn",
          database: "analytics",
          isExpanded: true,
          children: [
            {
              id: "conn:analytics:orders:__columns",
              label: "tree.columns",
              type: "group-columns",
              connectionId: "conn",
              database: "analytics",
              tableName: "orders",
              isExpanded: true,
              children: [
                {
                  id: "conn:analytics:orders:__columns:_id",
                  label: "_id",
                  type: "column",
                  connectionId: "conn",
                  database: "analytics",
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

  const collection = filtered[0]?.children?.[0];
  assert.equal(collection?.label, "orders");
  assert.equal(collection?.children?.[0]?.label, "tree.columns");
  assert.equal(collection?.children?.[0]?.children?.[0]?.label, "_id");
});

test("preserves loaded children when the connection itself matches search", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:1",
      label: "192.168.0.200_3306",
      type: "connection",
      connectionId: "conn:1",
      isExpanded: true,
      children: [
        {
          id: "conn:1:inventory",
          label: "inventory",
          type: "database",
          connectionId: "conn:1",
          database: "inventory",
          isExpanded: true,
          children: [
            {
              id: "conn:1:inventory:products",
              label: "products",
              type: "table",
              connectionId: "conn:1",
              database: "inventory",
            },
          ],
        },
      ],
    },
  ];

  const filtered = filterSidebarTree(nodes, "192.168.0.200", new Set());

  assert.equal(filtered[0]?.label, "192.168.0.200_3306");
  assert.equal(filtered[0]?.children?.[0]?.label, "inventory");
  assert.equal(filtered[0]?.children?.[0]?.children?.[0]?.label, "products");
});

test("matches table comments during sidebar search", () => {
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
          id: "conn:db:inventory",
          label: "inventory",
          type: "table",
          connectionId: "conn",
          database: "app",
          comment: "purchase order history",
        },
      ],
    },
  ];

  const filtered = filterSidebarTree(nodes, "purchase", new Set());

  assert.equal(filtered[0]?.children?.[0]?.label, "inventory");
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

function scopedSearchNodes(): TreeNode[] {
  return [
    {
      id: "conn:1",
      label: "warehouse",
      type: "connection",
      connectionId: "conn:1",
      isExpanded: true,
      children: [
        {
          id: "conn:1:db",
          label: "inventory",
          type: "database",
          connectionId: "conn:1",
          database: "inventory",
          isExpanded: true,
          children: [
            {
              id: "conn:1:db:sales-order",
              label: "sales_order",
              type: "schema",
              connectionId: "conn:1",
              database: "inventory",
              schema: "sales_order",
              isExpanded: true,
              children: [
                {
                  id: "conn:1:db:sales-order:orders",
                  label: "orders",
                  type: "table",
                  connectionId: "conn:1",
                  database: "inventory",
                  schema: "sales_order",
                },
              ],
            },
            {
              id: "conn:1:db:audit",
              label: "audit",
              type: "schema",
              connectionId: "conn:1",
              database: "inventory",
              schema: "audit",
              isExpanded: true,
              children: [
                {
                  id: "conn:1:db:audit:order-log",
                  label: "order_log",
                  type: "table",
                  connectionId: "conn:1",
                  database: "inventory",
                  schema: "audit",
                },
              ],
            },
          ],
        },
      ],
    },
  ];
}

test("filters the sidebar by node type without a text query", () => {
  const filtered = filterSidebarTree(scopedSearchNodes(), "", new Set(), new Set(["schema"]));

  const schemas = filtered[0]?.children?.[0]?.children;
  assert.deepEqual(
    schemas?.map((node) => node.label),
    ["sales_order", "audit"],
  );
  assert.deepEqual(
    schemas?.map((node) => node.children),
    [[], []],
  );
});

test("combines text search with the selected node types", () => {
  const filtered = filterSidebarTree(scopedSearchNodes(), "order", new Set(), new Set(["schema"]));

  assert.deepEqual(
    filtered[0]?.children?.[0]?.children?.map((node) => node.label),
    ["sales_order"],
  );
});

test("clearing the type filter restores default text search", () => {
  const filtered = filterSidebarTree(scopedSearchNodes(), "order", new Set());

  assert.deepEqual(
    filtered[0]?.children?.[0]?.children?.map((node) => node.label),
    ["sales_order", "audit"],
  );
});

test("clearing all search criteria preserves the original tree", () => {
  const nodes = scopedSearchNodes();

  assert.equal(filterSidebarTree(nodes, "", new Set()), nodes);
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

test("connection search copies preserve loading state", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:1",
      label: "Orders local",
      type: "connection",
      connectionId: "conn:1",
      isLoading: true,
      children: [
        {
          id: "conn:1:db",
          label: "orders",
          type: "database",
          connectionId: "conn:1",
          database: "orders",
        },
      ],
    },
  ];

  const filtered = filterSidebarTree(nodes, "orders", new Set());

  assert.equal(filtered[0]?.type, "connection");
  assert.equal(filtered[0]?.isLoading, true);
});
