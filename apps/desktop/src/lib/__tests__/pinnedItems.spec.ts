import { describe, expect, it } from "vitest";
import { updatePinnedTreeNodeInPlace } from "@/lib/pinnedItems";
import { buildTreeNodesFromLayout } from "@/lib/sidebarLayout";
import type { ConnectionConfig, SidebarLayout, TreeNode } from "@/types/database";

describe("sidebar pinned tree nodes", () => {
  it("reorders the pinned node within its parent", () => {
    const tree: TreeNode[] = [
      {
        id: "conn",
        label: "Connection",
        type: "connection",
        children: [
          { id: "conn:db:a", label: "A", type: "database" },
          { id: "conn:db:b", label: "B", type: "database" },
        ],
      },
    ];

    expect(updatePinnedTreeNodeInPlace(tree, "conn:db:b", true)).toBe("siblings");

    expect(tree[0].children?.map((node) => node.id)).toEqual(["conn:db:b", "conn:db:a"]);
    expect(tree[0].children?.[0].pinned).toBe(true);
  });

  it("reorders pinned root nodes in place", () => {
    const tree: TreeNode[] = [
      { id: "group-a", label: "A", type: "connection-group" },
      { id: "group-b", label: "B", type: "connection-group" },
    ];

    expect(updatePinnedTreeNodeInPlace(tree, "group-b", true)).toBe("root");

    expect(tree.map((node) => node.id)).toEqual(["group-b", "group-a"]);
    expect(tree[0].pinned).toBe(true);
  });

  it("applies pinned state to connection groups when rebuilding from layout", () => {
    const layout: SidebarLayout = {
      groups: [
        { id: "group-a", name: "A", collapsed: false },
        { id: "group-b", name: "B", collapsed: false },
      ],
      order: [
        { type: "group", id: "group-a", children: [] },
        { type: "group", id: "group-b", children: [] },
      ],
    };
    const connections: ConnectionConfig[] = [];

    const nodes = buildTreeNodesFromLayout(layout, connections, new Set(["group-b"]));

    expect(nodes.map((node) => node.id)).toEqual(["group-b", "group-a"]);
    expect(nodes[0].pinned).toBe(true);
  });
});
