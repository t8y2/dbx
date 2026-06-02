import { strict as assert } from "node:assert";
import test from "node:test";
import {
  selectedTreeNodesInVisibleOrder,
  treeSelectionRangeIds,
} from "../../apps/desktop/src/lib/sidebarTreeSelection.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";

const nodes: TreeNode[] = [
  { id: "orders", label: "orders", type: "table" },
  { id: "order_lines", label: "order_lines", type: "table" },
  { id: "products", label: "products", type: "table" },
  { id: "customers", label: "customers", type: "table" },
];

test("tree range selection uses the current visible node order", () => {
  const filtered = [nodes[0], nodes[1], nodes[3]];

  assert.deepEqual(treeSelectionRangeIds(filtered, "customers", "orders"), ["orders", "order_lines", "customers"]);
});

test("tree range selection falls back to the current node when the anchor is filtered out", () => {
  const filtered = [nodes[1], nodes[3]];

  assert.deepEqual(treeSelectionRangeIds(filtered, "customers", "orders"), ["customers"]);
});

test("selected tree nodes are ordered and limited by visible nodes", () => {
  const filtered = [nodes[1], nodes[3]];

  assert.deepEqual(
    selectedTreeNodesInVisibleOrder(filtered, ["products", "customers", "order_lines"]).map((node) => node.id),
    ["order_lines", "customers"],
  );
});
