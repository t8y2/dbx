import { describe, expect, it } from "vitest";
import { reactive } from "vue";
import { applyPinnedTreeNodeState, syncPinnedTreeNodeStateInPlace, treeNodePinKey, updatePinnedTreeNodeInPlace } from "@/lib/app/pinnedItems";
import type { TreeNode } from "@/types/database";
import {
  applyTableVGroupsToChildren,
  collectTableTreeNames,
  createTableVGroup,
  deleteTableVGroups,
  emptyTableVGroupLayout,
  findTableVGroupContainerNode,
  hasTableTreeLoadMore,
  isTableVGroupContainerNode,
  isTableVGroupGroupableRowType,
  moveTableToVGroup,
  normalizeTableVGroupLayout,
  pruneTableVGroupMembers,
  reorderTableVGroupEntry,
  resolveTableVGroupScopeFromNode,
  selectedTableVGroupMoveTargets,
  stripTableVGroupsFromChildren,
  tableVGroupDestinationRows,
  tableVGroupDropAcceptsRow,
  tableVGroupKindOfContainerNode,
  tableVGroupPathForTable,
  tableVGroupScopeKey,
  toggleTableVGroupCollapsed,
  type TableVGroupLayout,
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
  it("re-applying to already projected children does not duplicate group containers", () => {
    const created = createTableVGroup(emptyTableVGroupLayout(), "订单域");
    const layout = moveTableToVGroup(created.layout, "t_order", created.groupId);
    const first = applyTableVGroupsToChildren([tableNode("t_order"), tableNode("t_other")], layout, SCOPE);
    const second = applyTableVGroupsToChildren(first, layout, SCOPE);
    expect(groupIds(second)).toEqual(groupIds(first));
    expect(second.filter((node) => node.type === "table").map((node) => node.label)).toEqual(["t_other"]);
  });

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

describe("table virtual groups with pinned tree ordering", () => {
  function groupedTree() {
    const tables = ["t_a", "t_b", "t_c", "t_d", "t_e", "t_f"].map(tableNode);
    const loadMore = otherNode("load-more");
    const container: TreeNode = { id: "database", label: "db1", type: "database", ...SCOPE, children: [...tables, loadMore] };
    const tree = [container];
    const pinOrder = [treeNodePinKey(tables[5]!), treeNodePinKey(tables[0]!)];
    const pinnedIds = new Set(pinOrder);
    const layout: TableVGroupLayout = {
      version: 1,
      groups: [
        { id: "business", name: "Business", collapsed: false },
        { id: "nested", name: "Nested", collapsed: true },
        { id: "audit", name: "Audit", collapsed: false },
      ],
      order: [
        {
          type: "group",
          id: "business",
          children: [
            { type: "table", name: "t_d" },
            { type: "group", id: "nested", children: [{ type: "table", name: "t_b" }] },
            { type: "table", name: "t_a" },
          ],
        },
        { type: "group", id: "audit", children: [{ type: "table", name: "t_c" }] },
      ],
    };
    syncPinnedTreeNodeStateInPlace(tree, pinnedIds, pinOrder);
    container.children = applyTableVGroupsToChildren(container.children!, layout, SCOPE);
    return { tree, container, tables, loadMore, layout, pinnedIds, pinOrder };
  }

  it.each(["in-place", "reactive", "clone"])("preserves root and nested layout order during repeated %s pin synchronization", (mode) => {
    const fixture = groupedTree();
    let tree = mode === "reactive" ? reactive(fixture.tree) : fixture.tree;
    const snapshot = () => JSON.stringify(tree, ["id", "children", "isExpanded"]);
    const expected = snapshot();
    const savedLayout = JSON.stringify(fixture.layout);

    for (let iteration = 0; iteration < 3; iteration++) {
      if (mode === "clone") tree = applyPinnedTreeNodeState(tree, fixture.pinnedIds, fixture.pinOrder);
      else syncPinnedTreeNodeStateInPlace(tree, fixture.pinnedIds, fixture.pinOrder);
      expect(snapshot()).toBe(expected);
    }

    expect(tree[0]!.children?.map((node) => node.label)).toEqual(["Business", "Audit", "t_f", "t_e", "load-more"]);
    expect(tree[0]!.children?.[0]?.children?.map((node) => node.label)).toEqual(["t_d", "Nested", "t_a"]);
    expect(tree[0]!.children?.[0]?.children?.[2]?.pinned).toBe(true);
    expect(JSON.stringify(fixture.layout)).toBe(savedLayout);
    if (mode === "in-place") {
      expect(tree[0]!.children?.[0]?.children?.[0]).toBe(fixture.tables[3]);
      expect(tree[0]!.children?.at(-1)).toBe(fixture.loadMore);
    }
  });

  it("keeps explicit group member order when a member is pinned or unpinned directly", () => {
    const { tree, container, tables } = groupedTree();
    const members = container.children![0]!.children!;
    const expected = members.map((node) => node.id);

    expect(updatePinnedTreeNodeInPlace(tree, tables[0]!, false)).toBe("siblings");
    expect(container.children![0]!.children!.map((node) => node.id)).toEqual(expected);
    expect(updatePinnedTreeNodeInPlace(tree, tables[0]!, true)).toBe("siblings");
    expect(container.children![0]!.children!.map((node) => node.id)).toEqual(expected);
  });

  it("uses the latest group layout after drag reordering", () => {
    const { tree, container, layout, pinnedIds, pinOrder } = groupedTree();
    const reordered = reorderTableVGroupEntry(layout, "audit", "business", "before");
    container.children = applyTableVGroupsToChildren(container.children!, reordered, SCOPE);

    syncPinnedTreeNodeStateInPlace(tree, pinnedIds, pinOrder);

    expect(groupIds(container.children!)).toEqual(["table-vgroup:audit", "table-vgroup:business"]);
  });

  it("restores ordinary pinned and natural ordering when groups are disabled", () => {
    const { tree, container, tables, layout, pinnedIds, pinOrder } = groupedTree();
    syncPinnedTreeNodeStateInPlace(tree, pinnedIds, pinOrder);
    container.children = applyTableVGroupsToChildren(stripTableVGroupsFromChildren(container.children!), { ...layout, enabled: false }, SCOPE);

    syncPinnedTreeNodeStateInPlace(tree, pinnedIds, pinOrder);
    expect(container.children?.map((node) => node.label)).toEqual(["t_f", "t_a", "t_b", "t_c", "t_d", "t_e", "load-more"]);

    syncPinnedTreeNodeStateInPlace(tree, new Set());
    expect(container.children).toEqual([...tables, container.children!.at(-1)]);
  });

  it("still orders metadata below grouped tables by pin state", () => {
    const { tree, tables, pinnedIds, pinOrder } = groupedTree();
    const firstColumn: TreeNode = { id: "column-a", label: "a", type: "column", ...SCOPE };
    const lastColumn: TreeNode = { id: "column-z", label: "z", type: "column", ...SCOPE };
    tables[3]!.children = [firstColumn, lastColumn];
    const columnKey = treeNodePinKey(lastColumn);

    syncPinnedTreeNodeStateInPlace(tree, new Set([...pinnedIds, columnKey]), [...pinOrder, columnKey]);
    expect(tables[3]!.children).toEqual([lastColumn, firstColumn]);

    syncPinnedTreeNodeStateInPlace(tree, pinnedIds, pinOrder);
    expect(tables[3]!.children).toEqual([firstColumn, lastColumn]);
  });
});

describe("resolveTableVGroupScopeFromNode", () => {
  const databaseNode: TreeNode = { id: "conn-1:main", label: "main", type: "database", connectionId: "conn-1", database: "main" };
  const tablesGroup: TreeNode = { id: "conn-1:main:__tables", label: "Tables", type: "group-tables", connectionId: "conn-1", database: "main", schema: "main", children: [] };
  const row: TreeNode = { ...tableNode("t_order"), database: "main", schema: "main" };
  databaseNode.children = [tablesGroup];
  tablesGroup.children = [row];

  it("derives the same scope for a display group and its host container", () => {
    const fromGroup = resolveTableVGroupScopeFromNode([databaseNode], tablesGroup);
    const fromHost = resolveTableVGroupScopeFromNode([databaseNode], databaseNode);
    expect(fromGroup).toEqual(fromHost);
    // sqlite 语义下分组节点的 schema 填的是 effectiveSchema，不能泄漏进 scope。
    expect(fromGroup.schema).toBeUndefined();
  });

  it("derives a table row's scope from the host container, not the display group", () => {
    expect(resolveTableVGroupScopeFromNode([databaseNode], row)).toEqual(resolveTableVGroupScopeFromNode([databaseNode], databaseNode));
  });

  it("derives a projected group row's scope from the host container", () => {
    const groupRow: TreeNode = { id: "table-vgroup:g1", label: "回归组", type: "table-vgroup", vgroupId: "g1", connectionId: "conn-1", database: "main", schema: "main", children: [] };
    tablesGroup.children = [row, groupRow];
    expect(resolveTableVGroupScopeFromNode([databaseNode], groupRow)).toEqual(resolveTableVGroupScopeFromNode([databaseNode], databaseNode));
  });
});

describe("table tree helpers", () => {
  it("detects pagination cursors nested under table nodes", () => {
    const stable: TreeNode = { id: "stable", label: "st", type: "stable", children: [{ id: "lm", label: "more", type: "load-more" }] };
    expect(hasTableTreeLoadMore([stable])).toBe(true);
    expect(hasTableTreeLoadMore([tableNode("t_order")])).toBe(false);
  });

  it("collects table names from nested children", () => {
    const stable: TreeNode = { id: "stable", label: "st", type: "stable", children: [tableNode("t_child")] };
    const names = collectTableTreeNames([tableNode("t_order"), stable]);
    expect([...names].sort()).toEqual(["t_child", "t_order"]);
  });
});

describe("normalizeTableVGroupLayout", () => {
  it("keeps valid layouts at the current version and drops unknown fields", () => {
    const created = createTableVGroup(emptyTableVGroupLayout(), "订单域");
    const moved = moveTableToVGroup(created.layout, "t_order", created.groupId);
    const poisoned = JSON.parse(JSON.stringify(moved)) as Record<string, unknown> & { mode?: string; version?: number };
    poisoned.mode = "exclusive";
    poisoned.version = 99;

    const normalized = normalizeTableVGroupLayout(poisoned);
    expect(normalized.version).toBe(1);
    expect(normalized).not.toHaveProperty("mode");
    expect(normalized.order).toEqual(moved.order);
    expect(normalized.groups).toEqual(moved.groups);
  });

  it("returns an empty current-version layout for malformed payloads", () => {
    expect(normalizeTableVGroupLayout(null)).toEqual(emptyTableVGroupLayout());
    expect(normalizeTableVGroupLayout({ groups: "nope" })).toEqual(emptyTableVGroupLayout());
  });

  it("deduplicates repeated table names and group references within a level", () => {
    const created = createTableVGroup(emptyTableVGroupLayout(), "订单域");
    const layout = moveTableToVGroup(created.layout, "t_order", created.groupId);
    const withDuplicates = {
      ...layout,
      order: [
        {
          type: "group",
          id: created.groupId,
          children: [
            { type: "table", name: "t_order" },
            { type: "table", name: "t_order" },
          ],
        },
        { type: "group", id: created.groupId, children: [] },
      ],
    };
    const normalized = normalizeTableVGroupLayout(withDuplicates);
    expect(normalized.order).toEqual([{ type: "group", id: created.groupId, children: [{ type: "table", name: "t_order" }] }]);
  });
});

describe("pruneTableVGroupMembers", () => {
  it("drops members missing from a complete load but keeps the group itself", () => {
    const created = createTableVGroup(emptyTableVGroupLayout(), "订单域");
    let layout = moveTableToVGroup(created.layout, "t_order", created.groupId);
    layout = moveTableToVGroup(layout, "t_gone", created.groupId);

    const pruned = pruneTableVGroupMembers(layout, new Set(["t_order"]));
    expect(pruned).not.toBe(layout);
    expect(pruned.order).toEqual([{ type: "group", id: created.groupId, children: [{ type: "table", name: "t_order" }] }]);
    // 无失效成员时原样返回，不触发无谓的持久化。
    expect(pruneTableVGroupMembers(pruned, new Set(["t_order", "t_new"]))).toBe(pruned);
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

describe("container-kind scoped groups (views/procedures/triggers)", () => {
  const VIEW_SCOPE = { connectionId: "conn-1", database: "db1", objectType: "views" as const };

  function viewNode(name: string): TreeNode {
    return { id: `view:${name}`, label: name, type: "view", connectionId: "conn-1", database: "db1" };
  }

  function materializedViewNode(name: string): TreeNode {
    return { id: `mview:${name}`, label: name, type: "materialized_view", connectionId: "conn-1", database: "db1" };
  }

  it("keeps the tables scope key byte-identical and suffixes the other kinds", () => {
    expect(tableVGroupScopeKey({ connectionId: "conn-1", database: "db1" })).toBe("conn-1\u0000\u0000\u0000db1\u0000");
    expect(tableVGroupScopeKey(VIEW_SCOPE)).toBe("conn-1\u0000\u0000\u0000db1\u0000\u0000views");
    expect(tableVGroupScopeKey({ connectionId: "conn-1", database: "db1", objectType: "triggers" })).toBe("conn-1\u0000\u0000\u0000db1\u0000\u0000triggers");
  });

  it("maps containers to kinds and rejects table-child trigger groups", () => {
    expect(tableVGroupKindOfContainerNode({ type: "database" })).toBe("tables");
    expect(tableVGroupKindOfContainerNode({ type: "group-tables" })).toBe("tables");
    expect(tableVGroupKindOfContainerNode({ type: "group-views" })).toBe("views");
    expect(tableVGroupKindOfContainerNode({ type: "group-materialized-views" })).toBe("materialized_views");
    expect(tableVGroupKindOfContainerNode({ type: "group-procedures" })).toBe("procedures");
    expect(tableVGroupKindOfContainerNode({ type: "group-functions" })).toBe("functions");
    expect(tableVGroupKindOfContainerNode({ type: "group-triggers" })).toBe("triggers");
    expect(tableVGroupKindOfContainerNode({ type: "group-triggers", tableName: "t1" })).toBeNull();
    expect(tableVGroupKindOfContainerNode({ type: "group-sequences" })).toBe("sequences");
    expect(tableVGroupKindOfContainerNode({ type: "group-events" })).toBe("events");
    expect(tableVGroupKindOfContainerNode({ type: "group-synonyms" })).toBe("synonyms");
    expect(tableVGroupKindOfContainerNode({ type: "group-jobs" })).toBe("jobs");
    expect(tableVGroupKindOfContainerNode({ type: "group-packages" })).toBe("packages");
    expect(tableVGroupKindOfContainerNode({ type: "group-types" })).toBe("types");
    expect(tableVGroupKindOfContainerNode({ type: "group-tablespaces" })).toBeNull();
    expect(tableVGroupKindOfContainerNode({ type: "group-dolt-system-tables" })).toBeNull();
  });

  it("projects view rows under the views scope and passes non-member rows through", () => {
    const created = createTableVGroup(emptyTableVGroupLayout(), "支付视图");
    const withMember = moveTableToVGroup(created.layout, "v_payment", created.groupId);
    const projected = applyTableVGroupsToChildren([materializedViewNode("mv_a"), viewNode("v_payment"), viewNode("v_other")], withMember, VIEW_SCOPE);
    expect(groupIds(projected)).toHaveLength(1);
    expect(projected[0]!.label).toBe("支付视图");
    expect((projected[0]!.children ?? []).map((node) => node.label)).toEqual(["v_payment"]);
    expect(projected.map((node) => node.type)).toEqual(["table-vgroup", "materialized_view", "view"]);
  });

  it("re-projecting view containers stays idempotent", () => {
    const created = createTableVGroup(emptyTableVGroupLayout(), "分组");
    const withMember = moveTableToVGroup(created.layout, "v_a", created.groupId);
    const once = applyTableVGroupsToChildren([viewNode("v_a"), viewNode("v_b")], withMember, VIEW_SCOPE);
    const twice = applyTableVGroupsToChildren(once, withMember, VIEW_SCOPE);
    expect(groupIds(twice)).toEqual(groupIds(once));
  });

  it("resolves view rows and projected group rows to the views scope of the host", () => {
    const database: TreeNode = { id: "db:conn-1:db1", label: "db1", type: "database", connectionId: "conn-1", database: "db1" };
    const groupRow: TreeNode = { id: "table-vgroup:g1", label: "分组", type: "table-vgroup", connectionId: "conn-1", database: "db1", vgroupId: "g1" };
    const groupViews: TreeNode = { id: "gv:conn-1:db1", label: "Views", type: "group-views", connectionId: "conn-1", database: "db1", children: [groupRow, viewNode("v_a")] };
    const tree: TreeNode[] = [{ ...database, children: [groupViews, viewNode("v_a")] }];
    expect(resolveTableVGroupScopeFromNode(tree, viewNode("v_a"))).toMatchObject({ connectionId: "conn-1", database: "db1", objectType: "views" });
    expect(resolveTableVGroupScopeFromNode(tree, groupRow)).toMatchObject({ connectionId: "conn-1", database: "db1", objectType: "views" });
  });

  it("refuses a scope for view rows without a views container (simple mixed lists)", () => {
    const database: TreeNode = { id: "db:conn-1:db1", label: "db1", type: "database", connectionId: "conn-1", database: "db1", children: [tableNode("t_a"), viewNode("v_a")] };
    expect(tableVGroupScopeKey(resolveTableVGroupScopeFromNode([database], viewNode("v_a")))).toBeNull();
  });

  it("resolves a member row already inside a projected group to the same views scope", () => {
    const database: TreeNode = { id: "db:conn-1:db1", label: "db1", type: "database", connectionId: "conn-1", database: "db1" };
    const member: TreeNode = { id: "view:v_in_group", label: "v_in_group", type: "view", connectionId: "conn-1", database: "db1" };
    const groupRow: TreeNode = { id: "table-vgroup:g9", label: "组", type: "table-vgroup", connectionId: "conn-1", database: "db1", vgroupId: "g9", children: [member] };
    const groupViews: TreeNode = { id: "gv:2", label: "Views", type: "group-views", connectionId: "conn-1", database: "db1", children: [groupRow, viewNode("v_top")] };
    const tree: TreeNode[] = [{ ...database, children: [groupViews] }];
    expect(resolveTableVGroupScopeFromNode(tree, member)).toMatchObject({ connectionId: "conn-1", database: "db1", objectType: "views" });
  });

  it("narrows reprojection candidates to the scope kind even without a member label", () => {
    const database: TreeNode = { id: "db:conn-1:db1", label: "db1", type: "database", connectionId: "conn-1", database: "db1" };
    const groupTables: TreeNode = { id: "gt:1", label: "Tables", type: "group-tables", connectionId: "conn-1", database: "db1" };
    const groupFunctions: TreeNode = { id: "gf:1", label: "Functions", type: "group-functions", connectionId: "conn-1", database: "db1", children: [{ id: "fn:1", label: "vg_count", type: "function", connectionId: "conn-1", database: "db1" }] };
    const tree: TreeNode[] = [{ ...database, children: [groupTables, groupFunctions] }];
    expect(findTableVGroupContainerNode(tree, { connectionId: "conn-1", database: "db1", objectType: "tables" })).toBe(tree[0]);
  });

  it("collects member names per container kind", () => {
    const children = [viewNode("v_a"), tableNode("t_a"), materializedViewNode("mv_a")];
    expect(collectTableTreeNames(children, "views")).toEqual(new Set(["v_a"]));
    expect(collectTableTreeNames(children, "materialized_views")).toEqual(new Set(["mv_a"]));
    expect(collectTableTreeNames(children, "tables")).toEqual(new Set(["t_a"]));
  });

  it("keeps mixed selections type-pure when moving to groups", () => {
    const view = viewNode("v_a");
    const table = tableNode("t_a");
    expect(isTableVGroupGroupableRowType("materialized_view")).toBe(true);
    expect(isTableVGroupGroupableRowType("load-more")).toBe(false);
    expect(isTableVGroupGroupableRowType("index")).toBe(false);
    expect(selectedTableVGroupMoveTargets(view, [view, table])).toEqual([view]);
    expect(selectedTableVGroupMoveTargets(view, [view, viewNode("v_b")])).toEqual([view, viewNode("v_b")]);
  });

  it("finds the holding container of a member row by kind", () => {
    const database: TreeNode = { id: "db:conn-1:db1", label: "db1", type: "database", connectionId: "conn-1", database: "db1" };
    const groupViews: TreeNode = { id: "gv:conn-1:db1", label: "Views", type: "group-views", connectionId: "conn-1", database: "db1", children: [viewNode("v_a")] };
    const tree: TreeNode[] = [{ ...database, children: [groupViews] }];
    expect(isTableVGroupContainerNode(groupViews)).toBe(true);
    expect(findTableVGroupContainerNode(tree, { connectionId: "conn-1", database: "db1" }, "v_a", "view")).toBe(groupViews);
    // kind 隔离：表成员定位永不落入 views 容器；缺失成员回退宿主（分页语义）
    expect(findTableVGroupContainerNode(tree, { connectionId: "conn-1", database: "db1" }, "v_a", "table")).toBe(tree[0]);
    expect(findTableVGroupContainerNode(tree, { connectionId: "conn-1", database: "db1" }, "t_missing", "table")).toBe(tree[0]);
  });
});

describe("container-kind drop and scope isolation", () => {
  it("rejects cross-kind drop targets and accepts same-kind ones", () => {
    const database: TreeNode = { id: "db:conn-1:db1", label: "db1", type: "database", connectionId: "conn-1", database: "db1" };
    const groupViews: TreeNode = { id: "gv:1", label: "Views", type: "group-views", connectionId: "conn-1", database: "db1", children: [{ id: "vg-row:1", label: "分组", type: "table-vgroup", connectionId: "conn-1", database: "db1", vgroupId: "g1" }] };
    const tree: TreeNode[] = [{ ...database, children: [groupViews] }];
    expect(tableVGroupDropAcceptsRow(tree, groupViews, "view")).toBe(true);
    expect(tableVGroupDropAcceptsRow(tree, groupViews, "table")).toBe(false);
    expect(tableVGroupDropAcceptsRow(tree, database, "view")).toBe(false);
    expect(tableVGroupDropAcceptsRow(tree, database, "table")).toBe(true);
    const groupRow = groupViews.children![0]!;
    expect(tableVGroupDropAcceptsRow(tree, groupRow, "view")).toBe(true);
    expect(tableVGroupDropAcceptsRow(tree, groupRow, "table")).toBe(false);
  });

  it("refuses a scope for table-child trigger rows sharing names with database triggers", () => {
    const database: TreeNode = { id: "db:conn-1:db1", label: "db1", type: "database", connectionId: "conn-1", database: "db1" };
    const dbTrigger: TreeNode = { id: "dbtrig:1", label: "tg_a", type: "trigger", connectionId: "conn-1", database: "db1" };
    const dbTriggers: TreeNode = { id: "gt:1", label: "Triggers", type: "group-triggers", connectionId: "conn-1", database: "db1", children: [dbTrigger] };
    const tableTrigger: TreeNode = { id: "tbltrig:1", label: "tg_a", type: "trigger", connectionId: "conn-1", database: "db1", parentName: "t1" };
    const tableTriggers: TreeNode = { id: "tt:1", label: "Triggers", type: "group-triggers", connectionId: "conn-1", database: "db1", tableName: "t1", children: [tableTrigger] };
    const table: TreeNode = { id: "table:t1", label: "t1", type: "table", connectionId: "conn-1", database: "db1", children: [tableTriggers] };
    const tree: TreeNode[] = [{ ...database, children: [dbTriggers, table] }];
    expect(tableVGroupScopeKey(resolveTableVGroupScopeFromNode(tree, dbTrigger))).toBe("conn-1\u0000\u0000\u0000db1\u0000\u0000triggers");
    expect(tableVGroupScopeKey(resolveTableVGroupScopeFromNode(tree, tableTrigger))).toBeNull();
  });
});
