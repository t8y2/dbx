import type { TreeNode } from "@/types/database";

export function supportsSidebarModifierSelection(node: Pick<TreeNode, "type">): boolean {
  return node.type !== "database" && node.type !== "schema" && !node.type.startsWith("group-");
}

export function filterSidebarModifierSelectionIds(nodes: readonly TreeNode[], nodeIds: readonly string[]): string[] {
  const selectableIds = new Set(nodes.filter(supportsSidebarModifierSelection).map((node) => node.id));
  return nodeIds.filter((id) => selectableIds.has(id));
}

export function selectedTreeNodesInVisibleOrder(visibleNodes: TreeNode[], selectedIds: Iterable<string>): TreeNode[] {
  const ids = new Set(selectedIds);
  if (!ids.size) return [];
  return visibleNodes.filter((node) => ids.has(node.id));
}

export function selectedSidebarBatchTargets(activeNode: TreeNode, selectedNodes: readonly TreeNode[], canUseTarget: (node: TreeNode) => boolean): TreeNode[] {
  if (selectedNodes.length <= 1 || !selectedNodes.some((node) => node.id === activeNode.id)) return [];
  const first = selectedNodes[0];
  if (!first?.connectionId || !first.database || !selectedNodes.every((node) => node.type === first.type)) return [];
  if (!selectedNodes.every((node) => node.connectionId === first.connectionId && node.database === first.database && canUseTarget(node))) return [];
  return [...selectedNodes];
}

export function treeSelectionRangeIdsByIndex(visibleNodes: TreeNode[], currentIndex: number, anchorIndex: number, currentId?: string): string[] {
  if (anchorIndex < 0 || currentIndex < 0) return currentId ? [currentId] : [];
  const start = Math.min(anchorIndex, currentIndex);
  const end = Math.max(anchorIndex, currentIndex);
  return visibleNodes.slice(start, end + 1).map((node) => node.id);
}

export function treeSelectionRangeIds(visibleNodes: TreeNode[], currentId: string, anchorId?: string | null, selectedId?: string | null): string[] {
  const anchor = anchorId || selectedId || currentId;
  const anchorIndex = visibleNodes.findIndex((node) => node.id === anchor);
  const currentIndex = visibleNodes.findIndex((node) => node.id === currentId);
  return treeSelectionRangeIdsByIndex(visibleNodes, currentIndex, anchorIndex, currentId);
}
