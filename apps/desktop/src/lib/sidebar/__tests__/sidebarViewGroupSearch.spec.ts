import { describe, expect, it } from "vitest";
import { filterLocallySearchedTables, localTableSearchParentTypes } from "@/lib/sidebar/sidebarSearchTree";
import { insertSidebarTableSearchControls } from "@/lib/sidebar/sidebarTableSearchControl";
import type { FlatTreeNode } from "@/composables/useFlatTree";
import type { TreeNode } from "@/types/database";

function groupNode(type: TreeNode["type"], children: TreeNode[]): TreeNode {
  return {
    id: `conn:db@${type}`,
    label: type,
    type,
    connectionId: "conn",
    database: "app",
    isExpanded: true,
    children,
  };
}

function child(type: TreeNode["type"], name: string): TreeNode {
  return { id: `conn:db@${type}:${name}`, label: name, type, connectionId: "conn", database: "app" };
}

function flat(nodes: TreeNode[], depth = 0): FlatTreeNode[] {
  const out: FlatTreeNode[] = [];
  for (const node of nodes) {
    out.push({ node, depth, id: node.id, renderKey: node.id, type: node.type, poolType: `${node.type}:${node.id}` });
    if (node.children?.length) out.push(...flat(node.children, depth + 1));
  }
  return out;
}

describe("sidebar search for view groups (#12901)", () => {
  it("offers the search control on grouped views and materialized views", () => {
    const tree = [groupNode("group-tables", [child("table", "orders")]), groupNode("group-views", [child("view", "active_users")]), groupNode("group-materialized-views", [child("materialized_view", "daily_sales")])];
    const withControls = insertSidebarTableSearchControls(flat(tree), {
      enabled: true,
      sidebarObjectDisplay: "grouped",
      activeQueries: {},
    });
    const controlParents = withControls.filter(({ node }) => node.type === "table-search-control").map(({ node }) => node.tableSearchParentId);
    expect(controlParents).toHaveLength(3);
    expect(controlParents).toContain("conn:db@group-tables");
    expect(controlParents).toContain("conn:db@group-views");
    expect(controlParents).toContain("conn:db@group-materialized-views");
  });

  it("filters grouped view children by the local query, case-insensitively", () => {
    const views = groupNode("group-views", [child("view", "ActiveUsers"), child("view", "archived_sessions")]);
    const filtered = filterLocallySearchedTables([views], {
      enabled: true,
      queries: { "conn:db@group-views": "active" },
      indexedResults: {},
    });
    expect(filtered[0]?.children?.map((node) => node.label)).toEqual(["ActiveUsers"]);
    // Clearing the query restores the full list.
    const restored = filterLocallySearchedTables([views], { enabled: true, queries: { "conn:db@group-views": "" }, indexedResults: {} });
    expect(restored[0]?.children).toHaveLength(2);
  });

  it("registers the view group types as local search parents", () => {
    expect(localTableSearchParentTypes.has("group-views")).toBe(true);
    expect(localTableSearchParentTypes.has("group-materialized-views")).toBe(true);
  });
});
