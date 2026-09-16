import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { createFlatTreeIndex, SIDEBAR_TREE_ROW_HEIGHT, SIDEBAR_TREE_PRERENDER_COUNT, SIDEBAR_TREE_SCROLL_BUFFER, flattenTree, shouldVirtualizeFlatTree } from "../../apps/desktop/src/composables/useFlatTree.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";

const connectionTreeSource = readFileSync(new URL("../../apps/desktop/src/components/sidebar/ConnectionTree.vue", import.meta.url), "utf8");

test("flattenTree preserves depth and node type for virtualized sidebar rows", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn",
      label: "Connection",
      type: "connection",
      isExpanded: true,
      children: [
        { id: "conn:file", label: "Query.sql", type: "saved-sql-file" },
        {
          id: "conn:db",
          label: "db",
          type: "database",
          isExpanded: true,
          children: [{ id: "conn:db:table", label: "table", type: "table" }],
        },
      ],
    },
  ];

  const flat = flattenTree(nodes);

  assert.deepEqual(
    flat.map((item) => ({ id: item.id, depth: item.depth, type: item.type })),
    [
      { id: "conn", depth: 0, type: "connection" },
      { id: "conn:file", depth: 1, type: "saved-sql-file" },
      { id: "conn:db", depth: 1, type: "database" },
      { id: "conn:db:table", depth: 2, type: "table" },
    ],
  );
});

test("connection groups use per-node pool types to avoid recycled row state", () => {
  const nodes: TreeNode[] = [
    { id: "g1", label: "Group 1", type: "connection-group", isExpanded: false },
    { id: "g2", label: "Group 2", type: "connection-group", isExpanded: false },
    { id: "c1", label: "Connection", type: "connection", isExpanded: false },
  ];

  const flat = flattenTree(nodes);

  assert.equal(flat[0].type, "connection-group");
  assert.equal(flat[1].type, "connection-group");
  assert.notEqual(flat[0].poolType, flat[1].poolType);
  assert.equal(flat[2].poolType, "connection");
});

test("sticky containers prefer databases and fall back to schemas", () => {
  const flat = flattenTree([
    {
      id: "with-database",
      label: "With database",
      type: "connection",
      isExpanded: true,
      children: [
        {
          id: "database",
          label: "Database",
          type: "database",
          isExpanded: true,
          children: [
            {
              id: "database:schema",
              label: "Schema",
              type: "schema",
              isExpanded: true,
              children: [{ id: "database:schema:table", label: "Table", type: "table" }],
            },
          ],
        },
      ],
    },
    {
      id: "schema-only",
      label: "Schema only",
      type: "connection",
      isExpanded: true,
      children: [
        {
          id: "schema-only:schema",
          label: "Schema",
          type: "schema",
          isExpanded: true,
          children: [{ id: "schema-only:schema:table", label: "Table", type: "table" }],
        },
      ],
    },
  ]);
  const index = createFlatTreeIndex(flat, {
    isSelectable: () => true,
    isBoundary: (type) => type === "connection" || type === "connection-group",
    isDatabaseContainer: (type) => type === "database",
    isSchemaContainer: (type) => type === "schema",
  });

  assert.equal(index.stickyContainerIndexByIndex[1], 1);
  assert.equal(index.stickyContainerIndexByIndex[2], 1);
  assert.equal(index.stickyContainerIndexByIndex[3], 1);
  assert.equal(index.stickyContainerIndexByIndex[5], 5);
  assert.equal(index.stickyContainerIndexByIndex[6], 5);
});

test("shouldVirtualizeFlatTree keeps small/medium trees on the plain renderer", () => {
  assert.equal(shouldVirtualizeFlatTree(0), false);
  assert.equal(shouldVirtualizeFlatTree(1), false);
  assert.equal(shouldVirtualizeFlatTree(100), false);
  assert.equal(shouldVirtualizeFlatTree(499), false);
  assert.equal(shouldVirtualizeFlatTree(500), true);
  assert.equal(shouldVirtualizeFlatTree(5000), true);
});

test("sidebar virtual tree keeps enough buffered rows for fast scrolling", () => {
  assert.equal(SIDEBAR_TREE_ROW_HEIGHT, 28);
  assert.equal(SIDEBAR_TREE_SCROLL_BUFFER, 600);
  assert.ok(SIDEBAR_TREE_SCROLL_BUFFER >= SIDEBAR_TREE_ROW_HEIGHT * 20);
});

test("sidebar virtual tree prerenders enough rows for the first frame", () => {
  assert.ok(SIDEBAR_TREE_PRERENDER_COUNT >= 40);
});

test("sidebar virtual tree recycles rows by render identity", () => {
  assert.match(connectionTreeSource, /key-field="renderKey"/);
  assert.match(connectionTreeSource, /type-field="poolType"/);
  assert.match(connectionTreeSource, /\bflow-mode\b/);
});
