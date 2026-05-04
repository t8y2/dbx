import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcileLayout,
  buildTreeNodesFromLayout,
  createGroup,
  deleteGroup,
  renameGroup,
  moveConnectionToGroup,
  reorderEntry,
  toggleGroupCollapsed,
  appendConnectionToLayout,
  removeConnectionFromSidebarLayout,
  emptyLayout,
} from "../src/lib/sidebarLayout.ts";
import type { ConnectionConfig, SidebarLayout } from "../src/types/database.ts";

function conn(id: string, name?: string): ConnectionConfig {
  return {
    id,
    name: name || id,
    db_type: "postgres",
    host: "localhost",
    port: 5432,
    username: "user",
    password: "",
  };
}

// --- reconcileLayout ---

test("reconcileLayout returns all connections ungrouped when layout is null", () => {
  const result = reconcileLayout(["a", "b", "c"], null);
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.order, [
    { type: "connection", id: "a" },
    { type: "connection", id: "b" },
    { type: "connection", id: "c" },
  ]);
});

test("reconcileLayout appends new connections not in layout", () => {
  const layout: SidebarLayout = {
    groups: [],
    order: [{ type: "connection", id: "a" }],
  };
  const result = reconcileLayout(["a", "b"], layout);
  assert.equal(result.order.length, 2);
  assert.deepEqual(result.order[1], { type: "connection", id: "b" });
});

test("reconcileLayout removes stale connections from layout", () => {
  const layout: SidebarLayout = {
    groups: [{ id: "g1", name: "Group", collapsed: false }],
    order: [
      { type: "group", id: "g1", connectionIds: ["a", "removed"] },
      { type: "connection", id: "b" },
    ],
  };
  const result = reconcileLayout(["a", "b"], layout);
  const groupEntry = result.order.find((e) => e.type === "group");
  assert.ok(groupEntry && groupEntry.type === "group");
  assert.deepEqual(groupEntry.connectionIds, ["a"]);
  assert.equal(result.order.length, 2);
});

test("reconcileLayout removes groups with no order entry", () => {
  const layout: SidebarLayout = {
    groups: [
      { id: "g1", name: "Used", collapsed: false },
      { id: "g2", name: "Orphan", collapsed: false },
    ],
    order: [{ type: "group", id: "g1", connectionIds: ["a"] }],
  };
  const result = reconcileLayout(["a"], layout);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].id, "g1");
});

// --- buildTreeNodesFromLayout ---

test("buildTreeNodesFromLayout creates group nodes with connection children", () => {
  const layout: SidebarLayout = {
    groups: [{ id: "g1", name: "Production", collapsed: false }],
    order: [
      { type: "group", id: "g1", connectionIds: ["a", "b"] },
      { type: "connection", id: "c" },
    ],
  };
  const connections = [conn("a", "Server A"), conn("b", "Server B"), conn("c", "Server C")];
  const nodes = buildTreeNodesFromLayout(layout, connections, new Set());

  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].type, "connection-group");
  assert.equal(nodes[0].label, "Production");
  assert.equal(nodes[0].children?.length, 2);
  assert.equal(nodes[0].isExpanded, true);
  assert.equal(nodes[1].type, "connection");
  assert.equal(nodes[1].id, "c");
});

test("buildTreeNodesFromLayout respects collapsed groups", () => {
  const layout: SidebarLayout = {
    groups: [{ id: "g1", name: "G", collapsed: true }],
    order: [{ type: "group", id: "g1", connectionIds: ["a"] }],
  };
  const nodes = buildTreeNodesFromLayout(layout, [conn("a")], new Set());
  assert.equal(nodes[0].isExpanded, false);
});

test("buildTreeNodesFromLayout applies pinning within groups", () => {
  const layout: SidebarLayout = {
    groups: [{ id: "g1", name: "G", collapsed: false }],
    order: [{ type: "group", id: "g1", connectionIds: ["a", "b"] }],
  };
  const nodes = buildTreeNodesFromLayout(layout, [conn("a"), conn("b")], new Set(["b"]));
  const children = nodes[0].children!;
  assert.equal(children[0].id, "b");
  assert.equal(children[1].id, "a");
});

// --- createGroup ---

test("createGroup adds a new empty group", () => {
  const layout = emptyLayout();
  const result = createGroup(layout, "Dev");
  assert.equal(result.layout.groups.length, 1);
  assert.equal(result.layout.groups[0].name, "Dev");
  assert.equal(result.layout.order.length, 1);
  assert.ok(result.layout.order[0].type === "group");
});

// --- renameGroup ---

test("renameGroup updates group name", () => {
  const { layout, groupId } = createGroup(emptyLayout(), "Old");
  const result = renameGroup(layout, groupId, "New");
  assert.equal(result.groups[0].name, "New");
});

// --- deleteGroup ---

test("deleteGroup moves connections to ungrouped", () => {
  let layout = emptyLayout();
  layout = appendConnectionToLayout(layout, "a");
  const { layout: withGroup, groupId } = createGroup(layout, "G");
  const moved = moveConnectionToGroup(withGroup, "a", groupId);
  const result = deleteGroup(moved, groupId);

  assert.equal(result.groups.length, 0);
  assert.deepEqual(result.order, [{ type: "connection", id: "a" }]);
});

// --- toggleGroupCollapsed ---

test("toggleGroupCollapsed flips collapsed state", () => {
  const { layout, groupId } = createGroup(emptyLayout(), "G");
  assert.equal(layout.groups[0].collapsed, false);
  const toggled = toggleGroupCollapsed(layout, groupId);
  assert.equal(toggled.groups[0].collapsed, true);
});

// --- moveConnectionToGroup ---

test("moveConnectionToGroup moves connection into a group", () => {
  let layout: SidebarLayout = {
    groups: [{ id: "g1", name: "G", collapsed: false }],
    order: [
      { type: "group", id: "g1", connectionIds: [] },
      { type: "connection", id: "a" },
    ],
  };
  const result = moveConnectionToGroup(layout, "a", "g1");
  const groupEntry = result.order.find((e) => e.type === "group" && e.id === "g1");
  assert.ok(groupEntry && groupEntry.type === "group");
  assert.deepEqual(groupEntry.connectionIds, ["a"]);
  assert.equal(result.order.length, 1);
});

test("moveConnectionToGroup moves connection out of a group", () => {
  let layout: SidebarLayout = {
    groups: [{ id: "g1", name: "G", collapsed: false }],
    order: [{ type: "group", id: "g1", connectionIds: ["a"] }],
  };
  const result = moveConnectionToGroup(layout, "a", null);
  assert.equal(result.order.length, 2);
  assert.deepEqual(result.order[1], { type: "connection", id: "a" });
});

// --- reorderEntry ---

test("reorderEntry moves connection before another", () => {
  const layout: SidebarLayout = {
    groups: [],
    order: [
      { type: "connection", id: "a" },
      { type: "connection", id: "b" },
      { type: "connection", id: "c" },
    ],
  };
  const result = reorderEntry(layout, "c", "a", "before");
  assert.deepEqual(result.order.map((e) => e.id), ["c", "a", "b"]);
});

test("reorderEntry moves connection after another", () => {
  const layout: SidebarLayout = {
    groups: [],
    order: [
      { type: "connection", id: "a" },
      { type: "connection", id: "b" },
      { type: "connection", id: "c" },
    ],
  };
  const result = reorderEntry(layout, "a", "b", "after");
  assert.deepEqual(result.order.map((e) => e.id), ["b", "a", "c"]);
});

test("reorderEntry moves connection inside a group", () => {
  const layout: SidebarLayout = {
    groups: [{ id: "g1", name: "G", collapsed: false }],
    order: [
      { type: "group", id: "g1", connectionIds: [] },
      { type: "connection", id: "a" },
    ],
  };
  const result = reorderEntry(layout, "a", "g1", "inside");
  assert.equal(result.order.length, 1);
  const groupEntry = result.order[0];
  assert.ok(groupEntry.type === "group");
  assert.deepEqual(groupEntry.connectionIds, ["a"]);
});

test("reorderEntry is a no-op when dragging to same position", () => {
  const layout: SidebarLayout = {
    groups: [],
    order: [{ type: "connection", id: "a" }],
  };
  const result = reorderEntry(layout, "a", "a", "before");
  assert.deepEqual(result, layout);
});

// --- appendConnectionToLayout / removeConnectionFromSidebarLayout ---

test("appendConnectionToLayout adds to the end", () => {
  const layout = appendConnectionToLayout(emptyLayout(), "x");
  assert.equal(layout.order.length, 1);
  assert.deepEqual(layout.order[0], { type: "connection", id: "x" });
});

test("removeConnectionFromSidebarLayout removes from ungrouped", () => {
  let layout = appendConnectionToLayout(emptyLayout(), "x");
  layout = removeConnectionFromSidebarLayout(layout, "x");
  assert.equal(layout.order.length, 0);
});

test("removeConnectionFromSidebarLayout removes from inside a group", () => {
  const layout: SidebarLayout = {
    groups: [{ id: "g1", name: "G", collapsed: false }],
    order: [{ type: "group", id: "g1", connectionIds: ["a", "b"] }],
  };
  const result = removeConnectionFromSidebarLayout(layout, "a");
  const groupEntry = result.order[0];
  assert.ok(groupEntry.type === "group");
  assert.deepEqual(groupEntry.connectionIds, ["b"]);
});
