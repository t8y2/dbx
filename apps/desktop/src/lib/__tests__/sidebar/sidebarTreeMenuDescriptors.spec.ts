import { describe, expect, it } from "vitest";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { TreeNode, TreeNodeType } from "@/types/database";
import { createSidebarMenuContext, normalizeSidebarMenuDescriptors } from "@/lib/sidebar/sidebarTreeMenuDescriptors";

const representativeTypes: TreeNodeType[] = ["connection", "database", "schema", "table", "column", "mongo-db", "mongo-collection", "redis-db", "nacos-namespace"];

describe("sidebar tree menu descriptors", () => {
  it.each(representativeTypes)("normalizes stable descriptors for %s", (type) => {
    const node: TreeNode = { id: `${type}-1`, label: type, type };
    const items: ContextMenuItem[] = [
      { label: "Open", action: () => undefined },
      { label: "", separator: true },
      { label: "More", children: [{ label: "Delete", variant: "destructive" }] },
    ];
    const descriptors = normalizeSidebarMenuDescriptors(createSidebarMenuContext(node, [node.id]), items);

    expect(descriptors).toEqual([
      expect.objectContaining({ id: `${type}:0`, label: "Open", disabled: false, separator: false, variant: "default" }),
      expect.objectContaining({ id: `${type}:1`, separator: true }),
      expect.objectContaining({ id: `${type}:2`, children: [expect.objectContaining({ id: `${type}:2.0`, label: "Delete", variant: "destructive" })] }),
    ]);
  });

  it("freezes the accepted target and selection", () => {
    const node: TreeNode = { id: "table-1", label: "before", type: "table" };
    const selection = [node.id];
    const context = createSidebarMenuContext(node, selection, "postgres");
    node.label = "after";
    selection.push("table-2");

    expect(context.target.label).toBe("before");
    expect(context.selectedNodeIds).toEqual(["table-1"]);
    expect(Object.isFrozen(context)).toBe(true);
  });
});
