import type { TreeNode } from "@/types/database";

export function selectedTreeNodesInVisibleOrder(visibleNodes: TreeNode[], selectedIds: Iterable<string>): TreeNode[] {
  const ids = new Set(selectedIds);
  if (!ids.size) return [];
  return visibleNodes.filter((node) => ids.has(node.id));
}

export function treeSelectionRangeIds(
  visibleNodes: TreeNode[],
  currentId: string,
  anchorId?: string | null,
  selectedId?: string | null,
): string[] {
  const anchor = anchorId || selectedId || currentId;
  const anchorIndex = visibleNodes.findIndex((node) => node.id === anchor);
  const currentIndex = visibleNodes.findIndex((node) => node.id === currentId);
  if (anchorIndex < 0 || currentIndex < 0) return [currentId];
  const start = Math.min(anchorIndex, currentIndex);
  const end = Math.max(anchorIndex, currentIndex);
  return visibleNodes.slice(start, end + 1).map((node) => node.id);
}
