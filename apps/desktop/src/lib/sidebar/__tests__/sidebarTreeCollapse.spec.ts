import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/types/database";
import { collapseExpandedTreeNodes, collapseSubtreeDescendants } from "@/lib/sidebar/sidebarTreeCollapse";
import { toggleGroupCollapsed, emptyLayout, createGroup } from "@/lib/sidebar/sidebarLayout";
import { toggleTableVGroupCollapsed, emptyTableVGroupLayout, createTableVGroup } from "@/lib/table/tableVGroup";

describe("sidebarTreeCollapse", () => {
  it("collapseSubtreeDescendants collapses all child and descendant nodes while keeping parent untouched", () => {
    const parent: TreeNode = {
      id: "parent",
      label: "Parent",
      type: "database",
      isExpanded: true,
      children: [
        {
          id: "child-1",
          label: "Child 1",
          type: "schema",
          isExpanded: true,
          children: [
            {
              id: "grandchild-1",
              label: "Grandchild 1",
              type: "group-tables",
              isExpanded: true,
              children: [
                {
                  id: "table-1",
                  label: "Table 1",
                  type: "table",
                  isExpanded: true,
                },
              ],
            },
            {
              id: "grandchild-2",
              label: "Grandchild 2",
              type: "group-views",
              isExpanded: false,
            },
          ],
        },
        {
          id: "child-2",
          label: "Child 2",
          type: "schema",
          isExpanded: true,
        },
      ],
    };

    const count = collapseSubtreeDescendants(parent);
    expect(count).toBe(4);
    // Parent itself is untouched
    expect(parent.isExpanded).toBe(true);
    // Children and descendants are collapsed
    expect(parent.children![0].isExpanded).toBe(false);
    expect(parent.children![0].children![0].isExpanded).toBe(false);
    expect(parent.children![0].children![0].children![0].isExpanded).toBe(false);
    expect(parent.children![0].children![1].isExpanded).toBe(false);
    expect(parent.children![1].isExpanded).toBe(false);
  });

  it("collapseSubtreeDescendants returns 0 when node has no children", () => {
    const leaf: TreeNode = {
      id: "leaf",
      label: "Leaf",
      type: "table",
      isExpanded: true,
    };
    expect(collapseSubtreeDescendants(leaf)).toBe(0);
    expect(leaf.isExpanded).toBe(true);
  });

  it("toggleGroupCollapsed collapses all descendant connection groups when parent group collapses", () => {
    let layout = emptyLayout();
    const g1 = createGroup(layout, "Parent Group");
    layout = g1.layout;
    const g2 = createGroup(layout, "Child Group", g1.groupId);
    layout = g2.layout;
    const g3 = createGroup(layout, "Grandchild Group", g2.groupId);
    layout = g3.layout;

    // Initially all 3 groups are expanded (collapsed = false)
    expect(layout.groups.find((g) => g.id === g1.groupId)?.collapsed).toBe(false);
    expect(layout.groups.find((g) => g.id === g2.groupId)?.collapsed).toBe(false);
    expect(layout.groups.find((g) => g.id === g3.groupId)?.collapsed).toBe(false);

    // Collapsing Parent Group collapses itself and all its descendant groups
    const collapsed = toggleGroupCollapsed(layout, g1.groupId);
    expect(collapsed.groups.find((g) => g.id === g1.groupId)?.collapsed).toBe(true);
    expect(collapsed.groups.find((g) => g.id === g2.groupId)?.collapsed).toBe(true);
    expect(collapsed.groups.find((g) => g.id === g3.groupId)?.collapsed).toBe(true);

    // Expanding Parent Group reopens Parent Group only; descendant groups stay collapsed
    const reExpanded = toggleGroupCollapsed(collapsed, g1.groupId);
    expect(reExpanded.groups.find((g) => g.id === g1.groupId)?.collapsed).toBe(false);
    expect(reExpanded.groups.find((g) => g.id === g2.groupId)?.collapsed).toBe(true);
    expect(reExpanded.groups.find((g) => g.id === g3.groupId)?.collapsed).toBe(true);
  });

  it("toggleTableVGroupCollapsed collapses all descendant virtual groups when parent group collapses", () => {
    let layout = emptyTableVGroupLayout();
    const g1 = createTableVGroup(layout, "Parent VGroup");
    layout = g1.layout;
    const g2 = createTableVGroup(layout, "Child VGroup", g1.groupId);
    layout = g2.layout;

    expect(layout.groups.find((g) => g.id === g1.groupId)?.collapsed).toBe(false);
    expect(layout.groups.find((g) => g.id === g2.groupId)?.collapsed).toBe(false);

    const collapsed = toggleTableVGroupCollapsed(layout, g1.groupId);
    expect(collapsed.groups.find((g) => g.id === g1.groupId)?.collapsed).toBe(true);
    expect(collapsed.groups.find((g) => g.id === g2.groupId)?.collapsed).toBe(true);

    const reExpanded = toggleTableVGroupCollapsed(collapsed, g1.groupId);
    expect(reExpanded.groups.find((g) => g.id === g1.groupId)?.collapsed).toBe(false);
    expect(reExpanded.groups.find((g) => g.id === g2.groupId)?.collapsed).toBe(true);
  });
});
