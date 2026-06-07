import { strict as assert } from "node:assert";
import { test } from "node:test";
import { selectedConnectionDeleteTargets } from "../../apps/desktop/src/lib/sidebarConnectionSelection.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";

function node(id: string, type: TreeNode["type"] = "connection"): TreeNode {
  return { id, label: id, type, connectionId: type === "connection" ? id : "conn-1" };
}

test("deletes all selected connections when the context-clicked connection is selected", () => {
  const first = node("conn-1");
  const second = node("conn-2");

  assert.deepEqual(
    selectedConnectionDeleteTargets(first, [first, second]).map((target) => target.connectionId),
    ["conn-1", "conn-2"],
  );
});

test("falls back to only the current connection for mixed selections", () => {
  const connection = node("conn-1");
  const table = node("table-1", "table");

  assert.deepEqual(
    selectedConnectionDeleteTargets(connection, [connection, table]).map((target) => target.connectionId),
    ["conn-1"],
  );
});

test("falls back to only the current connection when right-clicking outside the selection", () => {
  const current = node("conn-1");
  const selected = node("conn-2");

  assert.deepEqual(
    selectedConnectionDeleteTargets(current, [selected]).map((target) => target.connectionId),
    ["conn-1"],
  );
});
