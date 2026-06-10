import { strict as assert } from "node:assert";
import { test } from "vitest";
import { applyPinnedTreeNodeState, orderPinnedFirst } from "../../apps/desktop/src/lib/pinnedItems.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";

test("orders pinned items before unpinned items without changing relative order", () => {
  const items = [{ id: "a" }, { id: "b", pinned: true }, { id: "c" }, { id: "d", pinned: true }, { id: "e" }];

  const ordered = orderPinnedFirst(items, (item) => !!item.pinned);

  assert.deepEqual(
    ordered.map((item) => item.id),
    ["b", "d", "a", "c", "e"],
  );
  assert.deepEqual(
    items.map((item) => item.id),
    ["a", "b", "c", "d", "e"],
  );
});

test("applies pinned state recursively to grouped tree nodes", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:db:__tables",
      label: "tree.tables",
      type: "group-tables",
      children: [
        { id: "conn:db:orders", label: "orders", type: "table" },
        { id: "conn:db:users", label: "users", type: "table" },
      ],
    },
  ];

  const result = applyPinnedTreeNodeState(nodes, new Set(["conn:db:users"]));

  assert.equal(result[0].children?.[0].id, "conn:db:users");
  assert.equal(result[0].children?.[0].pinned, true);
  assert.equal(result[0].children?.[1].id, "conn:db:orders");
  assert.equal(result[0].children?.[1].pinned, false);
});
