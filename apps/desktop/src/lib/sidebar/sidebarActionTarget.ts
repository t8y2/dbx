import type { TreeNode } from "@/types/database";

export type SidebarActionTarget = Readonly<TreeNode>;

export interface SidebarActionRequest<TPayload = undefined> {
  target: SidebarActionTarget;
  selectedNodeIds: readonly string[];
  payload: TPayload;
}

function sameActionTarget(left: TreeNode, right: SidebarActionTarget): boolean {
  return left.id === right.id && left.type === right.type && left.connectionId === right.connectionId && left.database === right.database && left.schema === right.schema && left.catalog === right.catalog && left.label === right.label && left.signature === right.signature;
}

export function findSidebarActionTarget(nodes: readonly TreeNode[], target: SidebarActionTarget): TreeNode | null {
  const visited = new WeakSet<TreeNode>();
  const find = (items: readonly TreeNode[]): TreeNode | null => {
    for (const node of items) {
      if (visited.has(node)) continue;
      visited.add(node);
      if (sameActionTarget(node, target)) return node;
      const child = node.children ? find(node.children) : null;
      if (child) return child;
      const hiddenChild = node.hiddenChildren ? find(node.hiddenChildren) : null;
      if (hiddenChild) return hiddenChild;
    }
    return null;
  };
  return find(nodes);
}

export function createSidebarActionTarget(node: TreeNode): SidebarActionTarget {
  // Virtual rows can be recycled while an async dialog is opening, so actions
  // must never retain the mutable row node or its potentially large child tree.
  const meta = node.meta && typeof node.meta === "object" ? Object.freeze({ ...node.meta }) : node.meta;
  return Object.freeze({ ...node, children: undefined, hiddenChildren: undefined, meta });
}

export function releaseRemovedSidebarActionTarget(node: TreeNode, removedNodeIds: readonly string[]): TreeNode {
  if (!removedNodeIds.includes(node.id)) return node;
  return { ...createSidebarActionTarget(node) };
}

export function createSidebarActionRequest<TPayload>(node: TreeNode, selectedNodeIds: readonly string[], payload: TPayload): SidebarActionRequest<TPayload> {
  return Object.freeze({
    target: createSidebarActionTarget(node),
    selectedNodeIds: Object.freeze([...selectedNodeIds]),
    payload,
  });
}
