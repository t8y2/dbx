import type { TreeNode, TreeNodeType } from "@/types/database";

export const SIDEBAR_TREE_ROW_HEIGHT = 28;
export const SIDEBAR_TREE_SCROLL_BUFFER = 600;
export const SIDEBAR_TREE_PRERENDER_COUNT = 48;

export interface FlatTreeNode {
  node: TreeNode;
  depth: number;
  id: string;
  type: TreeNodeType;
}

function walk(children: TreeNode[], depth: number, result: FlatTreeNode[]) {
  for (const node of children) {
    result.push({ node, depth, id: node.id, type: node.type });
    if (node.isExpanded && node.children) {
      walk(node.children, depth + 1, result);
    }
  }
}

export function flattenTree(nodes: TreeNode[]): FlatTreeNode[] {
  const result: FlatTreeNode[] = [];
  walk(nodes, 0, result);
  return result;
}

export function shouldVirtualizeFlatTree(count: number): boolean {
  return count > 0;
}

export function shouldAutoScrollExpandedTreeNode(type: TreeNodeType): boolean {
  return type !== "connection" && type !== "connection-group";
}

export function scrollTopForExpandedTreeNode(options: { expandedIndex: number; insertedRowCount: number; currentScrollTop: number; viewportHeight: number; rowHeight?: number }): number {
  const rowHeight = options.rowHeight ?? SIDEBAR_TREE_ROW_HEIGHT;
  if (options.expandedIndex < 0 || options.insertedRowCount <= 0 || options.viewportHeight <= 0) {
    return options.currentScrollTop;
  }

  const visibleRowCapacity = Math.max(1, Math.floor(options.viewportHeight / rowHeight) - 1);
  const rowsToReveal = Math.min(options.insertedRowCount, visibleRowCapacity);
  const expandedContentBottom = (options.expandedIndex + 1 + rowsToReveal) * rowHeight;
  const viewportBottom = options.currentScrollTop + options.viewportHeight;

  if (expandedContentBottom <= viewportBottom) {
    return options.currentScrollTop;
  }

  return Math.max(0, expandedContentBottom - options.viewportHeight);
}
