import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/types/database";
import { applyTableVGroupsToChildren, deleteTableVGroups, moveDatabaseVGroupMember, normalizeTableVGroupLayout, tableVGroupScopeKey, type TableVGroupLayout } from "@/lib/table/tableVGroup";
import { applyPinnedTreeNodeState, syncPinnedTreeNodeStateInPlace, treeNodePinKey } from "@/lib/app/pinnedItems";
import { orderSidebarConnectionUtilitiesForDisplay, sortSidebarTreeChildrenByNameKeepingTableVGroups, sortSidebarTreeChildrenForParent } from "../sidebarNodeOrdering";
import { databaseVGroupDropTarget } from "../sidebarTableVGroupDrag";

function fixture(catalog?: string) {
  const source: TreeNode = { id: "source", type: "database", label: "app", connectionId: "c", database: "app" };
  const peer: TreeNode = { ...source, id: "peer", database: "other", label: "other" };
  const flat: TreeNode = { ...source, id: "flat", database: "flat", label: "flat" };
  const scope = { connectionId: "c", catalog, objectType: "databases" as const };
  const layout: TableVGroupLayout = {
    groups: [
      { id: "a", name: "A", collapsed: false },
      { id: "b", name: "B", collapsed: true },
    ],
    order: [
      { type: "group", id: "a", children: [{ type: "table", name: "app", rowType: "database" }] },
      { type: "group", id: "b", children: [{ type: "table", name: "other", rowType: "database" }] },
    ],
  };
  const container: TreeNode = { id: catalog || "c", type: catalog ? "doris-catalog" : "connection", label: "Container", connectionId: "c", catalog, children: applyTableVGroupsToChildren([source, peer, flat], layout, scope) };
  const root: TreeNode = catalog ? { id: "c", type: "connection", label: "Connection", connectionId: "c", children: [container] } : container;
  const layouts = { [tableVGroupScopeKey(scope)!]: layout };
  return { source, peer, flat, scope, layout, container, root, layouts };
}

describe("database virtual group drop targets", () => {
  it.each([undefined, "internal"])("resolves group, sibling and root targets in %s", (catalog) => {
    const f = fixture(catalog);
    const target = f.container.children![1];
    expect(databaseVGroupDropTarget([f.root], f.source, target, f.layouts)).toMatchObject({ groupId: "b", scope: f.scope });
    expect(databaseVGroupDropTarget([f.root], f.source, f.peer, f.layouts)).toMatchObject({ groupId: "b" });
    expect(databaseVGroupDropTarget([f.root], f.source, f.flat, f.layouts)).toMatchObject({ groupId: null });
    expect(databaseVGroupDropTarget([f.root], f.source, f.container, f.layouts)).toMatchObject({ groupId: null });
    if (catalog) expect(databaseVGroupDropTarget([f.root], f.source, f.root, f.layouts)).toBeNull();
  });

  it.each(["before", "after"] as const)("drops beside a root folder at root level using the %s line", (position) => {
    const f = fixture();
    expect(databaseVGroupDropTarget([f.root], f.source, f.container.children![1], f.layouts, position)).toMatchObject({ groupId: null, position });
  });

  it.each(["before", "after"] as const)("drops beside a nested folder into its parent using the %s line", (position) => {
    const f = fixture();
    f.layout.groups.push({ id: "nested", name: "Nested", collapsed: false });
    const parent = f.layout.order[1];
    if (parent.type !== "group") throw new Error("Expected folder");
    parent.children!.push({ type: "group", id: "nested", children: [] });
    f.container.children = applyTableVGroupsToChildren(f.container.children!, f.layout, f.scope);
    const nested = f.container.children![1].children!.find((node) => node.vgroupId === "nested")!;
    expect(databaseVGroupDropTarget([f.root], f.source, nested, f.layouts, position)).toMatchObject({ groupId: "b", position });
    expect(databaseVGroupDropTarget([f.root], f.source, nested, f.layouts, "inside")).toMatchObject({ groupId: "nested", position: "inside" });
  });

  it.each(["before", "after"] as const)("inserts %s an implicit root database, preserving surrounding implicit rows", (position) => {
    const f = fixture();
    const tail: TreeNode = { ...f.flat, id: "tail", database: "tail", label: "tail" };
    f.container.children!.push(tail);
    const before = JSON.stringify(f.layout);
    const next = moveDatabaseVGroupMember(f.layout, f.source, { target: f.flat, position }, f.container.children!);
    const project = (layout: TableVGroupLayout) => applyTableVGroupsToChildren([f.flat, tail, f.peer, f.source], layout, f.scope).map((node) => node.label);
    const expected = position === "before" ? ["A", "B", "app", "flat", "tail"] : ["A", "B", "flat", "app", "tail"];
    expect(project(next)).toEqual(expected);
    expect(project(normalizeTableVGroupLayout(JSON.parse(JSON.stringify(next))))).toEqual(expected);
    expect(JSON.stringify(f.layout)).toBe(before);
  });

  it.each(["before", "after"] as const)("persists %s a nested folder without moving it or its hidden members", (position) => {
    const f = fixture("internal");
    f.layout.groups.push({ id: "nested", name: "Nested", collapsed: false });
    const parent = f.layout.order[1];
    if (parent.type !== "group") throw new Error("Expected group");
    parent.children!.push({ type: "group", id: "nested", children: [{ type: "table", name: "hidden", rowType: "database" }] });
    f.container.children = applyTableVGroupsToChildren(f.container.children!, f.layout, f.scope);
    const nested = f.container.children[1].children!.find((node) => node.vgroupId === "nested")!;
    const next = moveDatabaseVGroupMember(f.layout, f.source, { target: nested, position }, f.container.children);
    const saved = normalizeTableVGroupLayout(JSON.parse(JSON.stringify(next)));
    const hidden: TreeNode = { ...f.flat, id: "hidden", label: "hidden", database: "hidden" };
    const tree = applyTableVGroupsToChildren([hidden, f.peer, f.source, f.flat], saved, f.scope);
    expect(tree[1].children?.map((node) => node.label)).toEqual(position === "before" ? ["other", "app", "Nested"] : ["other", "Nested", "app"]);
    expect(tree[1].children?.find((node) => node.vgroupId === "nested")?.children).toEqual([hidden]);
  });

  it("keeps explicit root order through sorting, pin updates, cloning and removal of the last folder", () => {
    const f = fixture();
    const next = moveDatabaseVGroupMember(f.layout, f.source, { target: f.container.children![1], position: "before" }, f.container.children!);
    f.container.children = applyTableVGroupsToChildren(f.container.children!, next, f.scope);
    const savedSql: TreeNode = { id: "queries", type: "saved-sql-root", label: "Queries" };
    const utility: TreeNode = { id: "users", type: "user-admin", label: "Users" };
    f.container.children.push(utility, savedSql);
    const displayed = orderSidebarConnectionUtilitiesForDisplay([f.container]);
    const expected = ["Queries", "A", "app", "B", "flat", "Users"];
    expect(displayed[0].children?.map((node) => node.label)).toEqual(expected);
    for (const dbType of ["mysql", "mongodb", "milvus", "duckdb"] as const) {
      const sorted = sortSidebarTreeChildrenForParent(f.container, displayed[0].children!, dbType);
      expect(sorted.map((node) => node.label)).toEqual(expected);
      expect(sortSidebarTreeChildrenByNameKeepingTableVGroups(f.container, sorted, dbType).map((node) => node.label)).toEqual(expected);
      const pins = new Set([treeNodePinKey(f.flat)]);
      syncPinnedTreeNodeStateInPlace(sorted, pins);
      expect(sorted.map((node) => node.label)).toEqual(expected);
      expect(sorted.find((node) => node.id === f.flat.id)?.pinned).toBe(true);
      expect(applyPinnedTreeNodeState(sorted, pins).map((node) => node.label)).toEqual(expected);
    }
    const withoutGroups = deleteTableVGroups(next, ["a", "b"]);
    const tree = applyTableVGroupsToChildren([f.flat, f.peer, f.source], withoutGroups, f.scope);
    syncPinnedTreeNodeStateInPlace(tree, new Set());
    expect(sortSidebarTreeChildrenForParent(f.container, tree, "mysql").map((node) => node.label)).toEqual(["app", "other", "flat"]);
    const hidden = applyTableVGroupsToChildren(tree, { ...withoutGroups, enabled: false }, f.scope);
    expect(sortSidebarTreeChildrenForParent(f.container, hidden, "mysql").map((node) => node.label)).toEqual(["app", "flat", "other"]);
  });

  it("rejects a removed source or missing anchor without changing the saved layout", () => {
    const f = fixture();
    const deleted: TreeNode = { ...f.source, id: "removed", database: "removed" };
    expect(moveDatabaseVGroupMember(f.layout, deleted, { target: f.peer, position: "before" }, f.container.children!)).toBe(f.layout);
    expect(moveDatabaseVGroupMember(f.layout, f.source, { target: { ...f.peer, id: "gone", database: "gone" }, position: "after" }, f.container.children!)).toBe(f.layout);
  });

  it("rejects cross-connection, cross-catalog, table groups and unrelated targets", () => {
    const f = fixture("internal");
    const other: TreeNode = { id: "external", type: "doris-catalog", label: "External", connectionId: "c", catalog: "external", children: [] };
    f.root.children!.push(other);
    const targets: TreeNode[] = [
      other,
      { ...f.container, id: "foreign", connectionId: "other" },
      { ...f.container.children![1], id: "tables", vgroupKind: "tables", database: "app" },
      { ...f.source, id: "table", type: "table" },
      { id: "connections", type: "connection-group", label: "Connections" },
      f.source,
    ];
    for (const target of targets) expect(databaseVGroupDropTarget([f.root], f.source, target, f.layouts)).toBeNull();
    f.layout.enabled = false;
    expect(databaseVGroupDropTarget([f.root], f.source, f.container, f.layouts)).toBeNull();
  });
});
