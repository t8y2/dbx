import { strict as assert } from "node:assert";
import { test } from "vitest";
import { SIDEBAR_TREE_ROW_HEIGHT, SIDEBAR_TREE_PRERENDER_COUNT, SIDEBAR_TREE_SCROLL_BUFFER, flattenTree, shouldVirtualizeFlatTree } from "../../apps/desktop/src/composables/useFlatTree.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";

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

test("shouldVirtualizeFlatTree virtualizes every non-empty sidebar tree", () => {
  assert.equal(shouldVirtualizeFlatTree(0), false);
  assert.equal(shouldVirtualizeFlatTree(1), true);
  assert.equal(shouldVirtualizeFlatTree(100), true);
});

test("sidebar virtual tree keeps enough buffered rows for fast scrolling", () => {
  assert.equal(SIDEBAR_TREE_ROW_HEIGHT, 28);
  assert.equal(SIDEBAR_TREE_SCROLL_BUFFER, 600);
  assert.ok(SIDEBAR_TREE_SCROLL_BUFFER >= SIDEBAR_TREE_ROW_HEIGHT * 20);
});

test("sidebar virtual tree prerenders enough rows for the first frame", () => {
  assert.ok(SIDEBAR_TREE_PRERENDER_COUNT >= 40);
});
