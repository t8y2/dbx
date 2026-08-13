import type { TreeNode, TreeNodeType } from "@/types/database";
import { createSidebarLabelMatcher, type SidebarLabelMatcher } from "@/lib/sidebar/sidebarSearch";

const preserveMatchedSubtreeTypes = new Set(["connection", "database", "schema", "table", "view", "mongo-db", "mongo-collection"]);
const hiddenSearchNodeTypes = new Set<TreeNodeType>(["user-admin", "dameng-job-admin"]);

function bestMatch(matchLabel: SidebarLabelMatcher, label: string, comment?: string | null, aliases?: readonly string[]) {
  let best = matchLabel(label);
  for (const candidate of [comment, ...(aliases ?? [])]) {
    if (!candidate) continue;
    const match = matchLabel(candidate);
    if (match && (!best || match.score > best.score)) best = match;
  }
  return best;
}

function normalizedLabel(node: TreeNode): string {
  // Keep the original case. The matcher lowercases internally for comparison;
  // preserving case here lets it tokenize camelCase labels ("camelCaseTable"
  // -> "camel" | "Case" | "Table") instead of treating them as one lowercase
  // blob.
  return node.label;
}

function findNodePath(nodes: readonly TreeNode[], targetNodeId: string, ancestors: readonly TreeNode[] = []): readonly TreeNode[] | undefined {
  for (const node of nodes) {
    const path = [...ancestors, node];
    if (node.id === targetNodeId) return path;
    if (node.children) {
      const childPath = findNodePath(node.children, targetNodeId, path);
      if (childPath) return childPath;
    }
  }
  return undefined;
}

function nodePreservesSearchSubtree(node: TreeNode, matchLabel: SidebarLabelMatcher, searchableNodeTypes?: ReadonlySet<TreeNodeType>): boolean {
  if (searchableNodeTypes && !searchableNodeTypes.has(node.type)) return false;
  return preserveMatchedSubtreeTypes.has(node.type) && !!bestMatch(matchLabel, normalizedLabel(node), node.comment, node.searchAliases);
}

export function createSidebarSearchSubtreePreserver(query: string, searchableNodeTypes?: ReadonlySet<TreeNodeType>): (node: TreeNode) => boolean {
  const matchLabel = query ? createSidebarLabelMatcher(query) : undefined;
  return (node) => !!matchLabel && nodePreservesSearchSubtree(node, matchLabel, searchableNodeTypes);
}

export function resolveSidebarObjectSearchFilter(nodes: readonly TreeNode[], targetNodeId: string, query: string, searchableNodeTypes?: ReadonlySet<TreeNodeType>): string {
  if (!query) return query;
  const matchLabel = createSidebarLabelMatcher(query);
  const path = findNodePath(nodes, targetNodeId);
  const preservesSubtree = path?.some((node) => nodePreservesSearchSubtree(node, matchLabel, searchableNodeTypes));
  return preservesSubtree ? "" : query;
}

export function filterSidebarTree(nodes: TreeNode[], query: string, collapsedIds: ReadonlySet<string>, searchableNodeTypes?: ReadonlySet<TreeNodeType>): TreeNode[] {
  const matchLabel = query ? createSidebarLabelMatcher(query) : undefined;
  if (!matchLabel && searchableNodeTypes === undefined) return nodes;
  return filterSidebarTreeWithMatcher(nodes, matchLabel, collapsedIds, searchableNodeTypes);
}

export function reuseLiveSidebarTreeNodes(indexedNodes: TreeNode[], liveNodes: readonly TreeNode[]): TreeNode[] {
  const liveNodesById = new Map(liveNodes.map((node) => [node.id, node]));
  return indexedNodes.map((node) => liveNodesById.get(node.id) ?? node);
}

function applySearchCollapsedState(node: TreeNode, collapsedIds: ReadonlySet<string>): TreeNode {
  const children = node.children?.map((child) => applySearchCollapsedState(child, collapsedIds));
  const childrenChanged = children?.some((child, index) => child !== node.children?.[index]) ?? false;
  const collapsed = collapsedIds.has(node.id);
  if (!collapsed && !childrenChanged) return node;

  return {
    ...node,
    children: childrenChanged ? children : node.children,
    isExpanded: collapsed ? false : node.isExpanded,
  };
}

function preservedSearchChildren(node: TreeNode, collapsedIds: ReadonlySet<string>): TreeNode[] | undefined {
  if (!node.children) return undefined;
  return node.children.filter((child) => !hiddenSearchNodeTypes.has(child.type)).map((child) => applySearchCollapsedState(child, collapsedIds));
}

function filterSidebarTreeWithMatcher(nodes: TreeNode[], matchLabel: SidebarLabelMatcher | undefined, collapsedIds: ReadonlySet<string>, searchableNodeTypes?: ReadonlySet<TreeNodeType>): TreeNode[] {
  const filteredNodes: { node: TreeNode; score: number }[] = [];

  for (const node of nodes) {
    if (matchLabel && hiddenSearchNodeTypes.has(node.type)) continue;
    if (node.type === "object-browser" && node.hiddenChildren) {
      const matches = node.hiddenChildren.flatMap((child) => {
        if (searchableNodeTypes && !searchableNodeTypes.has(child.type)) return [];
        const match = matchLabel?.(normalizedLabel(child));
        if (matchLabel && !match) return [];
        return [{ node: child, score: match?.score ?? 0 }];
      });
      filteredNodes.push(...matches);
      continue;
    }

    const label = normalizedLabel(node);
    const canSelfMatch = !searchableNodeTypes || searchableNodeTypes.has(node.type);
    const selfMatch = canSelfMatch ? (matchLabel ? bestMatch(matchLabel, label, node.comment, node.searchAliases) : { score: 0 }) : null;
    // Type-only filtering keeps matching rows and their ancestor path, but not
    // unrelated descendants that would make the selected type appear ignored.
    const preservesSubtree = !!matchLabel && !!selfMatch && preserveMatchedSubtreeTypes.has(node.type);
    // A type-matched table keeps its loaded detail groups after the text query
    // is cleared instead of being rebuilt with an empty filtered child list.
    const preservesTypeMatchedTable = !matchLabel && !!selfMatch && node.type === "table";
    // Connection utility entries are synthetic navigation actions, not schema
    // search results. Keep real loaded descendants for connection-name matches,
    // but do not let those actions make a disconnected result look expanded.
    const filteredChildren = preservesSubtree ? preservedSearchChildren(node, collapsedIds) : node.children ? filterSidebarTreeWithMatcher(node.children, matchLabel, collapsedIds, searchableNodeTypes) : undefined;

    if (selfMatch || (filteredChildren && filteredChildren.length > 0)) {
      if (!node.children || preservesTypeMatchedTable) {
        filteredNodes.push({ node, score: selfMatch?.score ?? 0 });
      } else {
        const children = filteredChildren ?? [];
        filteredNodes.push({
          node: {
            ...node,
            children,
            isLoading: node.isLoading,
            isExpanded: children.length > 0 && !collapsedIds.has(node.id),
          },
          score: selfMatch?.score ?? 0,
        });
      }
    }
  }

  filteredNodes.sort((a, b) => b.score - a.score);
  return filteredNodes.map((match) => match.node);
}

export function filterSidebarSearchRootsByConnectionState(nodes: TreeNode[], connectedIds: ReadonlySet<string>): TreeNode[] {
  return nodes.filter((node) => {
    if (node.type === "connection-group" || node.type === "connection") return true;
    return node.connectionId ? connectedIds.has(node.connectionId) : true;
  });
}

export function resolveSidebarFilterGuards(showConnectedConnectionsOnly: boolean, searchQuery: string, hasSearchScopeFilter: boolean) {
  const isTreeSearchFiltering = !!searchQuery.trim() || hasSearchScopeFilter;
  return {
    isTreeSearchFiltering,
    isRootListPartial: showConnectedConnectionsOnly || isTreeSearchFiltering,
  };
}

/**
 * Produces a display-only connection tree containing connected connections and
 * the groups that contain them. Connection descendants stay intact because
 * this filter controls the connection list, not database-object visibility.
 */
export function filterSidebarTreeToConnectedConnections(nodes: readonly TreeNode[], connectedIds: ReadonlySet<string>): TreeNode[] {
  let changed = false;
  const filtered: TreeNode[] = [];

  for (const node of nodes) {
    if (node.type === "connection") {
      if (node.connectionId && connectedIds.has(node.connectionId)) {
        filtered.push(node);
      } else {
        changed = true;
      }
      continue;
    }

    if (node.type !== "connection-group") {
      filtered.push(node);
      continue;
    }

    const children = filterSidebarTreeToConnectedConnections(node.children ?? [], connectedIds);
    if (children.length === 0) {
      changed = true;
      continue;
    }
    if (children !== node.children) {
      changed = true;
      filtered.push({ ...node, children });
    } else {
      filtered.push(node);
    }
  }

  return changed ? filtered : (nodes as TreeNode[]);
}
