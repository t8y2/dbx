import type { TreeNode } from "@/types/database";
import { findSidebarActionTarget } from "@/lib/sidebar/sidebarActionTarget";

export function syncSidebarTreeNodeExpansion(nodes: readonly TreeNode[], renderedNode: TreeNode, expanded: boolean): boolean {
  const liveNode = findSidebarActionTarget(nodes, renderedNode);
  if (!liveNode || liveNode === renderedNode || liveNode.isExpanded === expanded) return false;
  liveNode.isExpanded = expanded;
  return true;
}
