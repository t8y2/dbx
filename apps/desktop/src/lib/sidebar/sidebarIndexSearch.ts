import { appendFlatTreeRenderKey, type FlatTreeNode } from "@/composables/useFlatTree";
import type { TreeNode } from "@/types/database";

export function hideSimpleSidebarIndexes(nodes: TreeNode[]): TreeNode[] {
  let changed = false;
  const visible: TreeNode[] = [];
  for (const node of nodes) {
    if ((node.type === "index" && node.objectScope === "schema") || node.loadMore?.objectType === "INDEX") {
      changed = true;
      continue;
    }
    const children = node.children?.length ? hideSimpleSidebarIndexes(node.children) : node.children;
    if (children !== node.children) {
      changed = true;
      visible.push({ ...node, children });
    } else {
      visible.push(node);
    }
  }
  return changed ? visible : nodes;
}

export function filterConnectionIndexes(nodes: readonly TreeNode[], connectionIds: ReadonlySet<string>, queries: Readonly<Record<string, string>>): TreeNode[] {
  return nodes.map((node) => {
    if (node.type === "connection-group" && node.children?.length) {
      const originalChildren = node.children;
      const children = filterConnectionIndexes(originalChildren, connectionIds, queries);
      if (children.some((child, index) => child !== originalChildren[index])) return { ...node, children };
      return node;
    }
    if (node.type !== "connection" || !connectionIds.has(node.connectionId ?? node.id)) return node;
    const query = queries[node.id]?.trim().toLowerCase();
    if (!query || !node.children) return node;
    return {
      ...node,
      children: node.children.filter((child) => child.type !== "elasticsearch-index" || [child.label, ...(child.searchAliases ?? [])].some((name) => name.toLowerCase().includes(query))),
    };
  });
}

export function insertConnectionIndexSearchControls(flatNodes: readonly FlatTreeNode[], connectionIds: ReadonlySet<string>): FlatTreeNode[] {
  const result: FlatTreeNode[] = [];
  for (const item of flatNodes) {
    result.push(item);
    const parent = item.node;
    if (parent.type !== "connection" || !connectionIds.has(parent.connectionId ?? parent.id) || !parent.isExpanded || parent.children === undefined) continue;
    const node: TreeNode = {
      id: `${parent.id}:__index_search`,
      type: "table-search-control",
      label: "sidebar.searchIndexesInCurrentConnection",
      connectionId: parent.connectionId,
      tableSearchParentId: parent.id,
      indexSearchOnly: true,
    };
    result.push({ node, depth: item.depth + 1, id: node.id, renderKey: appendFlatTreeRenderKey(item.renderKey, node), type: node.type, poolType: `${node.type}:${node.id}` });
  }
  return result;
}
