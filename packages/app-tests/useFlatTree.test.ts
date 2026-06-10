import { strict as assert } from "node:assert";
import { test } from "vitest";
import { SIDEBAR_TREE_ROW_HEIGHT, SIDEBAR_TREE_PRERENDER_COUNT, SIDEBAR_TREE_SCROLL_BUFFER, flattenTree, scrollTopForExpandedTreeNode, shouldAutoScrollExpandedTreeNode, shouldVirtualizeFlatTree } from "../../apps/desktop/src/composables/useFlatTree.ts";
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

test("sidebar keeps root connection expansion from changing scroll position", () => {
  assert.equal(shouldAutoScrollExpandedTreeNode("connection"), false);
  assert.equal(shouldAutoScrollExpandedTreeNode("connection-group"), false);
  assert.equal(shouldAutoScrollExpandedTreeNode("database"), true);
  assert.equal(shouldAutoScrollExpandedTreeNode("group-columns"), true);
});

test("expanded sidebar nodes scroll enough to reveal inserted rows", () => {
  assert.equal(
    scrollTopForExpandedTreeNode({
      expandedIndex: 20,
      insertedRowCount: 2,
      currentScrollTop: 15 * SIDEBAR_TREE_ROW_HEIGHT,
      viewportHeight: 6 * SIDEBAR_TREE_ROW_HEIGHT,
    }),
    17 * SIDEBAR_TREE_ROW_HEIGHT,
  );
});

test("expanded sidebar nodes keep scroll position when children are already visible", () => {
  assert.equal(
    scrollTopForExpandedTreeNode({
      expandedIndex: 4,
      insertedRowCount: 2,
      currentScrollTop: 0,
      viewportHeight: 8 * SIDEBAR_TREE_ROW_HEIGHT,
    }),
    0,
  );
});
