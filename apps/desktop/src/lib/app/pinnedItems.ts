import type { TreeNode } from "@/types/database";

export type PinnedTreeNodeUpdateScope = "missing" | "root" | "siblings";

export function orderPinnedFirst<T>(items: T[], isPinned: (item: T) => boolean): T[] {
  const pinned: T[] = [];
  const unpinned: T[] = [];

  for (const item of items) {
    if (isPinned(item)) pinned.push(item);
    else unpinned.push(item);
  }

  return [...pinned, ...unpinned];
}

function findTreeNodeLocation(nodes: TreeNode[], id: string, parent: TreeNode | null = null): { node: TreeNode; parent: TreeNode | null } | null {
  for (const node of nodes) {
    if (node.id === id) return { node, parent };
    if (node.children) {
      const found = findTreeNodeLocation(node.children, id, node);
      if (found) return found;
    }
  }
  return null;
}

export function updatePinnedTreeNodeInPlace(nodes: TreeNode[], id: string, pinned: boolean): PinnedTreeNodeUpdateScope {
  const location = findTreeNodeLocation(nodes, id);
  if (!location) return "missing";

  location.node.pinned = pinned;
  const siblings = location.parent?.children ?? nodes;
  const ordered = orderPinnedFirst(siblings, (node) => !!node.pinned);

  if (location.parent) {
    location.parent.children = ordered;
    return "siblings";
  }

  nodes.splice(0, nodes.length, ...ordered);
  return "root";
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
