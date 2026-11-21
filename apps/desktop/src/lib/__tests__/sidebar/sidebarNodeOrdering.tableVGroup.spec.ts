import { describe, expect, it } from "vitest";
import { sortSidebarTreeChildrenByNameKeepingTableVGroups } from "@/lib/sidebar/sidebarNodeOrdering";
import { applyTableVGroupsToChildren, createTableVGroup, emptyTableVGroupLayout, moveTableToVGroup } from "@/lib/table/tableVGroup";
import type { TreeNode } from "@/types/database";

const SCOPE = { connectionId: "conn-1", database: "db1" };

function tableNode(name: string): TreeNode {
  return { id: `table:${name}`, label: name, type: "table", connectionId: "conn-1", database: "db1" };
}

/** Mirrors connectionStore.mergeLocatedTreeChildren: merge a page, then re-sort. */
function mergePageLikeStore(parent: TreeNode, children: TreeNode[], page: TreeNode[]): TreeNode[] {
  return sortSidebarTreeChildrenByNameKeepingTableVGroups(parent, [...children, ...page], "mysql");
}

describe("sidebar ordering keeps projected table groups pinned", () => {
  it("keeps a virtual table group at the top after a paged merge re-sorts children by name", () => {
    const created = createTableVGroup(emptyTableVGroupLayout(), "zzz-分组");
    const layout = moveTableToVGroup(created.layout, "t_order", created.groupId);
    const parent: TreeNode = { id: "group-tables:db1", label: "tables", type: "group-tables", connectionId: "conn-1", database: "db1" };

    // What the sidebar shows after the layout projection runs.
    const projected = applyTableVGroupsToChildren([tableNode("t_user"), tableNode("t_order")], layout, SCOPE);
    expect(projected[0]!.type).toBe("table-vgroup");

    // A sidebar page merge must not move the projected group out of the top
    // slot: the layout, not the alphabet, decides where a group sits.
    const merged = mergePageLikeStore(parent, projected, [tableNode("t_zzz")]);
    expect(merged[0]!.type).toBe("table-vgroup");
    expect(merged.slice(1).map((node) => node.label)).toEqual(["t_user", "t_zzz"]);
    expect(merged[0]!.children?.map((node) => node.label)).toEqual(["t_order"]);
  });

  it("keeps projected groups in layout order when their labels sort differently", () => {
    const first = createTableVGroup(emptyTableVGroupLayout(), "b-组");
    let layout = moveTableToVGroup(first.layout, "t_order", first.groupId);
    const second = createTableVGroup(layout, "a-组");
    layout = moveTableToVGroup(second.layout, "t_pay", second.groupId);
    const parent: TreeNode = { id: "group-tables:db1", label: "tables", type: "group-tables", connectionId: "conn-1", database: "db1" };

    const projected = applyTableVGroupsToChildren([tableNode("t_user"), tableNode("t_order"), tableNode("t_pay")], layout, SCOPE);
    const merged = mergePageLikeStore(parent, projected, [tableNode("t_zzz")]);
    expect(merged.filter((node) => node.type === "table-vgroup").map((node) => node.label)).toEqual(["b-组", "a-组"]);
  });
});
