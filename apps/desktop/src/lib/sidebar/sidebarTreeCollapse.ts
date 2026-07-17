import type { TreeNode } from "@/types/database";

export function collapseExpandedTreeNodes(nodes: TreeNode[]): number {
  let collapsedCount = 0;

  for (const node of nodes) {
    if (node.isExpanded) {
      node.isExpanded = false;
      collapsedCount += 1;
    }
    if (node.children?.length) {
      collapsedCount += collapseExpandedTreeNodes(node.children);
    }
  }

  return collapsedCount;
}
