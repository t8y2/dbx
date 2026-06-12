import assert from "node:assert/strict";
import { test } from "vitest";
import { buildTreeNodesFromLayout, deleteGroup, moveConnectionToGroup, reconcileLayout, reorderEntry } from "../../apps/desktop/src/lib/sidebarLayout.ts";
import type { ConnectionConfig, SidebarLayout } from "../../apps/desktop/src/types/database.ts";

function conn(id: string): ConnectionConfig {
  return {
    id,
    name: id,
    db_type: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
    password: "",
  };
}

test("reconciles legacy grouped layout into nested children", () => {
  const layout: SidebarLayout = {
    groups: [{ id: "g1", name: "Group", collapsed: false }],
    order: [{ type: "group", id: "g1", connectionIds: ["c1"] }],
  };

  const reconciled = reconcileLayout(["c1", "c2"], layout);

  assert.deepEqual(reconciled.order, [
    { type: "group", id: "g1", children: [{ type: "connection", id: "c1" }] },
    { type: "connection", id: "c2" },
  ]);
});

test("builds nested connection group tree nodes", () => {
  const layout: SidebarLayout = {
    groups: [
      { id: "g1", name: "Parent", collapsed: false },
      { id: "g2", name: "Child", collapsed: false },
    ],
    order: [
      {
        type: "group",
        id: "g1",
        children: [{ type: "group", id: "g2", children: [{ type: "connection", id: "c1" }] }],
      },
    ],
  };

  const nodes = buildTreeNodesFromLayout(layout, [conn("c1")], new Set());

  assert.deepEqual(
    nodes.map((node) => [node.type, node.label, node.children?.[0]?.type, node.children?.[0]?.children?.[0]?.id]),
    [["connection-group", "Parent", "connection-group", "c1"]],
  );
});

test("moves connections and groups into nested groups", () => {
  const layout: SidebarLayout = {
    groups: [
      { id: "g1", name: "Parent", collapsed: false },
      { id: "g2", name: "Child", collapsed: false },
    ],
    order: [
      { type: "group", id: "g1", children: [] },
      { type: "group", id: "g2", children: [] },
      { type: "connection", id: "c1" },
    ],
  };

  const withNestedGroup = reorderEntry(layout, "g2", "g1", "inside");
  const withNestedConnection = moveConnectionToGroup(withNestedGroup, "c1", "g2");

  assert.deepEqual(withNestedConnection.order, [
    {
      type: "group",
      id: "g1",
      children: [{ type: "group", id: "g2", children: [{ type: "connection", id: "c1" }] }],
    },
  ]);
});

test("deleting a parent group keeps nested child groups", () => {
  const layout: SidebarLayout = {
    groups: [
      { id: "g1", name: "Parent", collapsed: false },
      { id: "g2", name: "Child", collapsed: false },
    ],
    order: [{ type: "group", id: "g1", children: [{ type: "group", id: "g2", children: [{ type: "connection", id: "c1" }] }] }],
  };

  const next = deleteGroup(layout, "g1");

  assert.deepEqual(next.groups, [{ id: "g2", name: "Child", collapsed: false }]);
  assert.deepEqual(next.order, [{ type: "group", id: "g2", children: [{ type: "connection", id: "c1" }] }]);
});
