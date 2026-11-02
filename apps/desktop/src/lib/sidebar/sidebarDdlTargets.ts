import type { TreeNode } from "@/types/database";
import { sidebarDdlTargetsForExecutionContext } from "@/lib/sidebar/sidebarDdlTemplate";
import { sidebarStructureExportTargets } from "@/lib/sidebar/sidebarExportRuntime";

export type SidebarDdlTarget = TreeNode & { connectionId: string; database: string };

export function resolveSidebarDdlTargets(activeNode: TreeNode, treeNodes: readonly TreeNode[], selectedNodeIds: readonly string[]): SidebarDdlTarget[] {
  const targets = sidebarStructureExportTargets(activeNode, treeNodes, selectedNodeIds);
  if (!targets.length || !activeNode.connectionId || !activeNode.database) return [];
  return sidebarDdlTargetsForExecutionContext(activeNode as SidebarDdlTarget, targets);
}
