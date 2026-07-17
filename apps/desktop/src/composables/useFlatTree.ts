import type { TreeNode, TreeNodeType } from "@/types/database";

export const SIDEBAR_TREE_ROW_HEIGHT = 28;
export const SIDEBAR_TREE_SCROLL_BUFFER = 600;
export const SIDEBAR_TREE_PRERENDER_COUNT = 48;

export interface FlatTreeNode {
  node: TreeNode;
  depth: number;
  id: string;
  type: TreeNodeType;
  poolType: string;
}

export interface FlatTreeIndex {
  visibleNodes: TreeNode[];
  selectableVisibleNodes: TreeNode[];
  selectableVisibleNodeIndexById: Map<string, number>;
  flatNodeIndexById: Map<string, number>;
  nodeById: Map<string, TreeNode>;
  expandableNodeIds: string[];
  stickyContainerIndexByIndex: Int32Array;
  nextDatabaseContainerIndexByIndex: Int32Array;
  nextSchemaContainerIndexByIndex: Int32Array;
}

interface FlatTreeIndexOptions {
  isSelectable: (node: TreeNode) => boolean;
  isBoundary: (type: TreeNodeType) => boolean;
  isDatabaseContainer: (type: TreeNodeType) => boolean;
  isSchemaContainer: (type: TreeNodeType) => boolean;
}

function walk(children: TreeNode[], depth: number, result: FlatTreeNode[]) {
  for (const node of children) {
    result.push({
      node,
      depth,
      id: node.id,
      type: node.type,
      poolType: node.type === "connection-group" ? `${node.type}:${node.id}` : node.type,
    });
    if (node.isExpanded && node.children) {
      walk(node.children, depth + 1, result);
    }
  }
}

function flatTreeNode(node: TreeNode, depth: number): FlatTreeNode {
  return {
    node,
    depth,
    id: node.id,
    type: node.type,
    poolType: node.type === "connection-group" ? `${node.type}:${node.id}` : node.type,
  };
}

function visibleDescendantEnd(nodes: readonly FlatTreeNode[], parentIndex: number): number {
  const parentDepth = nodes[parentIndex]?.depth;
  if (parentDepth == null) return parentIndex;
  let end = parentIndex + 1;
  while (end < nodes.length && nodes[end].depth > parentDepth) end += 1;
  return end;
}

export function flattenTree(nodes: TreeNode[]): FlatTreeNode[] {
  const result: FlatTreeNode[] = [];
  walk(nodes, 0, result);
  return result;
}

export function replaceFlatTreeChildren(nodes: readonly FlatTreeNode[], parentIndex: number, parent: TreeNode): FlatTreeNode[] {
  if (parentIndex < 0 || parentIndex >= nodes.length || nodes[parentIndex].id !== parent.id) return [...nodes];

  const end = visibleDescendantEnd(nodes, parentIndex);
  const replacement: FlatTreeNode[] = [];
  if (parent.isExpanded && parent.children) walk(parent.children, nodes[parentIndex].depth + 1, replacement);

  // One splice-shaped replacement keeps recycled-list consumers from observing
  // an intermediate state where old and new child ranges coexist.
  return [...nodes.slice(0, parentIndex), flatTreeNode(parent, nodes[parentIndex].depth), ...replacement, ...nodes.slice(end)];
}

export function mutateFlatTreeExpansion(nodes: readonly FlatTreeNode[], parentIndex: number, parent: TreeNode, expanded: boolean): FlatTreeNode[] {
  if (parent.isExpanded !== expanded) parent.isExpanded = expanded;
  return replaceFlatTreeChildren(nodes, parentIndex, parent);
}

export function shouldVirtualizeFlatTree(count: number): boolean {
  return count > 0;
}

export function createFlatTreeIndex(nodes: readonly FlatTreeNode[], options: FlatTreeIndexOptions): FlatTreeIndex {
  const visibleNodes: TreeNode[] = [];
  const selectableVisibleNodes: TreeNode[] = [];
  const selectableVisibleNodeIndexById = new Map<string, number>();
  const flatNodeIndexById = new Map<string, number>();
  const nodeById = new Map<string, TreeNode>();
  const expandableNodeIds: string[] = [];
  const stickyContainerIndexByIndex = new Int32Array(nodes.length);
  const nextDatabaseContainerIndexByIndex = new Int32Array(nodes.length);
  const nextSchemaContainerIndexByIndex = new Int32Array(nodes.length);
  stickyContainerIndexByIndex.fill(-1);
  nextDatabaseContainerIndexByIndex.fill(-1);
  nextSchemaContainerIndexByIndex.fill(-1);

  let databaseContainerIndex = -1;
  let schemaContainerIndex = -1;
  for (let index = 0; index < nodes.length; index += 1) {
    const item = nodes[index];
    const node = item.node;
    visibleNodes.push(node);
    flatNodeIndexById.set(item.id, index);
    nodeById.set(item.id, node);
    if (node.children?.length) expandableNodeIds.push(item.id);
    if (options.isSelectable(node)) {
      selectableVisibleNodeIndexById.set(item.id, selectableVisibleNodes.length);
      selectableVisibleNodes.push(node);
    }

    if (options.isBoundary(item.type)) {
      databaseContainerIndex = -1;
      schemaContainerIndex = -1;
      continue;
    }
    if (options.isDatabaseContainer(item.type)) databaseContainerIndex = index;
    if (options.isSchemaContainer(item.type)) schemaContainerIndex = index;
    stickyContainerIndexByIndex[index] = databaseContainerIndex >= 0 ? databaseContainerIndex : schemaContainerIndex;
  }

  let nextDatabaseContainerIndex = -1;
  let nextSchemaContainerIndex = -1;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const item = nodes[index];
    if (options.isBoundary(item.type)) {
      nextDatabaseContainerIndex = -1;
      nextSchemaContainerIndex = -1;
      continue;
    }
    nextDatabaseContainerIndexByIndex[index] = nextDatabaseContainerIndex;
    nextSchemaContainerIndexByIndex[index] = nextSchemaContainerIndex;
    if (options.isDatabaseContainer(item.type)) nextDatabaseContainerIndex = index;
    if (options.isSchemaContainer(item.type)) nextSchemaContainerIndex = index;
  }

  return {
    visibleNodes,
    selectableVisibleNodes,
    selectableVisibleNodeIndexById,
    flatNodeIndexById,
    nodeById,
    expandableNodeIds,
    stickyContainerIndexByIndex,
    nextDatabaseContainerIndexByIndex,
    nextSchemaContainerIndexByIndex,
  };
}
