import type { TreeNode } from "@/types/database";
import { findSidebarActionTarget } from "@/lib/sidebar/sidebarActionTarget";
import { collapseSubtreeDescendants } from "@/lib/sidebar/sidebarTreeCollapse";

export { collapseSubtreeDescendants } from "@/lib/sidebar/sidebarTreeCollapse";

export function syncSidebarTreeNodeExpansion(nodes: readonly TreeNode[], renderedNode: TreeNode, expanded: boolean): boolean {
  const liveNode = findSidebarActionTarget(nodes, renderedNode);
  if (!liveNode) return false;
  if (!expanded) {
    collapseSubtreeDescendants(liveNode);
  }
  if (liveNode === renderedNode || liveNode.isExpanded === expanded) return false;
  liveNode.isExpanded = expanded;
  return true;
}
