import { test } from "vitest";
import assert from "node:assert/strict";
import { connectionPasteTargetGroupId, selectedConnectionClipboardNodes, selectedConnectionClipboardTargets, selectedConnectionEditTarget } from "../../apps/desktop/src/lib/sidebar/sidebarConnectionSelection.ts";
import type { TreeNode } from "../../apps/desktop/src/types/database.ts";

function connectionNode(id: string): TreeNode {
  return {
    id,
    label: id,
    type: "connection",
    connectionId: id,
  };
}

test("uses selected connections as clipboard targets only when the selection is connection-only", () => {
  const first = connectionNode("conn-1");
  const second = connectionNode("conn-2");
  const table: TreeNode = {
    id: "table-1",
    label: "users",
    type: "table",
    connectionId: "conn-1",
    database: "main",
  };

  assert.deepEqual(selectedConnectionClipboardNodes([first, second]).map((node) => node.connectionId), ["conn-1", "conn-2"]);
  assert.deepEqual(selectedConnectionClipboardNodes([first, table]), []);
  assert.deepEqual(selectedConnectionClipboardTargets(first, [first, second]).map((node) => node.connectionId), ["conn-1", "conn-2"]);
  assert.deepEqual(selectedConnectionClipboardTargets(first, [first, table]).map((node) => node.connectionId), ["conn-1"]);
});

test("resolves connection paste target groups from the selected sidebar node", () => {
  const group: TreeNode = {
    id: "group-1",
    label: "Group",
    type: "connection-group",
  };
  const connection = connectionNode("conn-1");
  const table: TreeNode = {
    id: "table-1",
    label: "users",
    type: "table",
    connectionId: "conn-1",
    database: "main",
  };

  const groupIdForConnection = (connectionId: string) => (connectionId === "conn-1" ? "group-1" : null);

  assert.equal(connectionPasteTargetGroupId(group, groupIdForConnection), "group-1");
  assert.equal(connectionPasteTargetGroupId(connection, groupIdForConnection), "group-1");
  assert.equal(connectionPasteTargetGroupId(table, groupIdForConnection), null);
  assert.equal(connectionPasteTargetGroupId(null, groupIdForConnection), null);
});

test("allows editing only a single selected connection", () => {
  const first = connectionNode("conn-1");
  const second = connectionNode("conn-2");
  const table: TreeNode = {
    id: "table-1",
    label: "users",
    type: "table",
    connectionId: "conn-1",
    database: "main",
  };

  assert.equal(selectedConnectionEditTarget(first, [first])?.connectionId, "conn-1");
  assert.equal(selectedConnectionEditTarget(first, [first, second]), null);
  assert.equal(selectedConnectionEditTarget(table, [table]), null);
});
