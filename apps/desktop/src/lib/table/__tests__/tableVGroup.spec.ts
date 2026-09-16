import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/types/database";
import {
  applyTableVGroupsToChildren,
  createTableVGroup,
  deleteTableVGroups,
  emptyTableVGroupLayout,
  moveTableToVGroup,
  reorderTableVGroupEntry,
  selectedTableVGroupMoveTargets,
  stripTableVGroupsFromChildren,
  tableVGroupDestinationRows,
  tableVGroupPathForTable,
  tableVGroupScopeKey,
  toggleTableVGroupCollapsed,
} from "@/lib/table/tableVGroup";

const SCOPE = { connectionId: "conn-1", database: "db1" };

function tableNode(name: string): TreeNode {
  return { id: `table:${name}`, label: name, type: "table", connectionId: "conn-1", database: "db1" };
}

function otherNode(id: string): TreeNode {
  return { id, label: id, type: "load-more" };
}

function groupIds(nodes: TreeNode[]): string[] {
  return nodes.filter((node) => node.type === "table-vgroup").map((node) => node.id);
}

describe("tableVGroup layout ops", () => {
  it("moves a table into a group and back to the ungrouped root", () => {
    const created = createTableVGroup(emptyTableVGroupLayout(), "订单域");
    const moved = moveTableToVGroup(created.layout, "t_order", created.groupId);
    expect(moved.order).toEqual([{ type: "group", id: created.groupId, children: [{ type: "table", name: "t_order" }] }]);

    const removed = moveTableToVGroup(moved, "t_order", null);
    expect(removed.order).toEqual([
      { type: "group", id: created.groupId, children: [] },
      { type: "table", name: "t_order" },
    ]);
  });

  it("creates nested subgroups under an existing group", () => {
    const parent = createTableVGroup(emptyTableVGroupLayout(), "父分组");
    const child = createTableVGroup(parent.layout, "子分组", parent.groupId);
    const rows = tableVGroupDestinationRows(child.layout);
    expect(rows.map((row) => row.path)).toEqual([["父分组"], ["父分组", "子分组"]]);
  });

  it("deletes groups and flattens nested members back to the parent level", () => {
    const outer = createTableVGroup(emptyTableVGroupLayout(), "外层");
    const inner = createTableVGroup(outer.layout, "内层", outer.groupId);
    let layout = moveTableToVGroup(inner.layout, "t_a", inner.groupId);
    layout = moveTableToVGroup(layout, "t_b", outer.groupId);

    const deleted = deleteTableVGroups(layout, [outer.groupId]);
    expect(deleted.groups).toEqual([]);
    expect(deleted.order).toEqual([
      { type: "table", name: "t_a" },
      { type: "table", name: "t_b" },
    ]);
  });

  it("toggles group collapsed state", () => {
    const created = createTableVGroup(emptyTableVGroupLayout(), "分组");
    const toggled = toggleTableVGroupCollapsed(created.layout, created.groupId);
    expect(toggled.groups[0]?.collapsed).toBe(true);
    expect(toggleTableVGroupCollapsed(toggled, created.groupId).groups[0]?.collapsed).toBe(false);
  });

  it("reorders a group into another group and refuses cycles", () => {
    const a = createTableVGroup(emptyTableVGroupLayout(), "A");
    const b = createTableVGroup(a.layout, "B");
    const nested = reorderTableVGroupEntry(b.layout, a.groupId, b.groupId, "inside");
    expect(nested.order.map((entry) => (entry.type === "group" ? entry.id : entry.name))).toEqual([b.groupId]);
    expect(findGroupChildren(nested, b.groupId)).toEqual([a.groupId]);

    // Moving B under its own descendant A must be a no-op.
    const cyclic = reorderTableVGroupEntry(nested, b.groupId, a.groupId, "inside");
    expect(cyclic).toBe(nested);
  });

  it("resolves the group path for a table", () => {
    const parent = createTableVGroup(emptyTableVGroupLayout(), "父");
    const child = createTableVGroup(parent.layout, "子", parent.groupId);
    const layout = moveTableToVGroup(child.layout, "t_order", child.groupId);
    expect(tableVGroupPathForTable(layout, "t_order")).toEqual([parent.groupId, child.groupId]);
    expect(tableVGroupPathForTable(layout, "t_missing")).toEqual([]);
  });

  it("builds a stable scope key", () => {
    expect(tableVGroupScopeKey({ connectionId: "c", database: "db", schema: "s" })).toBe("c\u0000\u0000\u0000db\u0000s");
    expect(tableVGroupScopeKey({ connectionId: "c", database: "db" })).toBe("c\u0000\u0000\u0000db\u0000");
    expect(tableVGroupScopeKey({ connectionId: "c" })).toBeNull();
  });

  it("moves the whole selection only when every selected table shares the scope", () => {
    const a = tableNode("t_a");
    const b = tableNode("t_b");
    const otherDb = { ...tableNode("t_c"), connectionId: "conn-2" };
    const view = { ...tableNode("t_v"), type: "view" as const };

    expect(selectedTableVGroupMoveTargets(a, [a, b])).toEqual([a, b]);
    // 混入其他库或非表节点时回退为只移动右键的那一张。
    expect(selectedTableVGroupMoveTargets(a, [a, otherDb])).toEqual([a]);
    expect(selectedTableVGroupMoveTargets(a, [a, view])).toEqual([a]);
    // 右键节点不在选区内时只移动右键节点。
    expect(selectedTableVGroupMoveTargets(a, [b])).toEqual([a]);
  });
});

describe("applyTableVGroupsToChildren", () => {
  it("projects groups at the top of the container and keeps other rows in place", () => {
    const created = createTableVGroup(emptyTableVGroupLayout(), "订单域");
    let layout = moveTableToVGroup(created.layout, "t_order", created.groupId);
    layout = moveTableToVGroup(layout, "t_pay", created.groupId);

    const tUser = tableNode("t_user");
    const tOrder = tableNode("t_order");
    const tPay = tableNode("t_pay");
    const loadMore = otherNode("load-more");
    const projected = applyTableVGroupsToChildren([tUser, tOrder, tPay, loadMore], layout, SCOPE);

    expect(projected).toHaveLength(3);
    expect(groupIds(projected)).toEqual([`table-vgroup:${created.groupId}`]);
    expect(projected[0]!.type).toBe("table-vgroup");
    const groupNode = projected[0]!;
    expect(groupNode.isExpanded).toBe(true);
    expect(groupNode.children?.map((node) => node.label)).toEqual(["t_order", "t_pay"]);
    // Table nodes keep their object identity so loaded state survives projection.
    expect(groupNode.children?.[0]).toBe(tOrder);
    expect(projected[2]).toBe(loadMore);
  });

  it("skips unknown members and keeps ungrouped tables when disabled", () => {
    const created = createTableVGroup(emptyTableVGroupLayout(), "空组");
    const layout = { ...moveTableToVGroup(created.layout, "t_ghost", created.groupId), enabled: false };

    const tUser = tableNode("t_user");
    const projected = applyTableVGroupsToChildren([tUser], layout, SCOPE);
    expect(projected).toEqual([tUser]);
  });

  it("returns the input untouched for empty layouts or empty children", () => {
    const children = [tableNode("t_user")];
    expect(applyTableVGroupsToChildren(children, emptyTableVGroupLayout(), SCOPE)).toBe(children);
    expect(applyTableVGroupsToChildren([], emptyTableVGroupLayout(), SCOPE)).toEqual([]);
    expect(applyTableVGroupsToChildren(children, undefined, SCOPE)).toBe(children);
  });

  it("strips projected groups back into a flat list preserving table identity", () => {
    const created = createTableVGroup(emptyTableVGroupLayout(), "订单域");
    const layout = moveTableToVGroup(created.layout, "t_order", created.groupId);
    const tOrder = tableNode("t_order");
    const projected = applyTableVGroupsToChildren([tOrder], layout, SCOPE);
    const stripped = stripTableVGroupsFromChildren(projected);
    expect(stripped.map((node) => node.label)).toEqual(["t_order"]);
    expect(stripped[0]).toBe(tOrder);
  });
});

function findGroupChildren(layout: ReturnType<typeof reorderTableVGroupEntry>, groupId: string): string[] {
  const visit = (entries: typeof layout.order): string[] => {
    for (const entry of entries) {
      if (entry.type !== "group") continue;
      if (entry.id === groupId) return (entry.children ?? []).flatMap((child) => (child.type === "group" ? [child.id] : []));
      const found = visit(entry.children ?? []);
      if (found.length) return found;
    }
    return [];
  };
  return visit(layout.order);
}
