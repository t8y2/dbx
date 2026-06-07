import type { TreeNode } from "@/types/database";

export function orderPinnedFirst<T>(items: T[], isPinned: (item: T) => boolean): T[] {
  const pinned: T[] = [];
  const unpinned: T[] = [];

  for (const item of items) {
    if (isPinned(item)) pinned.push(item);
    else unpinned.push(item);
  }

  return [...pinned, ...unpinned];
}

export function applyPinnedTreeNodeState(nodes: TreeNode[], pinnedIds: Set<string>): TreeNode[] {
  return orderPinnedFirst(
    nodes.map((node) => ({
      ...node,
      pinned: pinnedIds.has(node.id),
      children: node.children ? applyPinnedTreeNodeState(node.children, pinnedIds) : node.children,
    })),
    (node) => !!node.pinned,
  );
}
