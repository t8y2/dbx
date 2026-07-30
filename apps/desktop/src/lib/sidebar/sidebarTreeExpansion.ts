import type { TreeNode } from "@/types/database";
import { findSidebarActionTarget } from "@/lib/sidebar/sidebarActionTarget";

export function syncSidebarTreeNodeExpansion(nodes: readonly TreeNode[], renderedNode: TreeNode): boolean {
  const liveNode = findSidebarActionTarget(nodes, renderedNode);
  if (!liveNode || liveNode === renderedNode || liveNode.isExpanded === renderedNode.isExpanded) return false;
  liveNode.isExpanded = renderedNode.isExpanded;
  return true;
}
