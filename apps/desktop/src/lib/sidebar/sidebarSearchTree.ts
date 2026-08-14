import type { TableInfo, TreeNode, TreeNodeType } from "@/types/database";
import { createSidebarLabelMatcher, type SidebarLabelMatcher, type SidebarSearchMatcherOptions } from "@/lib/sidebar/sidebarSearch";
import { buildTableTreeNodes } from "@/lib/table/tableTree";

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

export function createSidebarSearchSubtreePreserver(query: string, searchableNodeTypes?: ReadonlySet<TreeNodeType>, options?: SidebarSearchMatcherOptions): (node: TreeNode) => boolean {
  const matchLabel = query ? createSidebarLabelMatcher(query, options) : undefined;
  return (node) => !!matchLabel && nodePreservesSearchSubtree(node, matchLabel, searchableNodeTypes);
}

export function resolveSidebarObjectSearchFilter(nodes: readonly TreeNode[], targetNodeId: string, query: string, searchableNodeTypes?: ReadonlySet<TreeNodeType>, options?: SidebarSearchMatcherOptions): string {
  if (!query) return query;
  const matchLabel = createSidebarLabelMatcher(query, options);
  const path = findNodePath(nodes, targetNodeId);
  const preservesSubtree = path?.some((node) => nodePreservesSearchSubtree(node, matchLabel, searchableNodeTypes));
  return preservesSubtree ? "" : query;
}

export function filterSidebarTree(nodes: TreeNode[], query: string, collapsedIds: ReadonlySet<string>, searchableNodeTypes?: ReadonlySet<TreeNodeType>, options?: SidebarSearchMatcherOptions): TreeNode[] {
  const matchLabel = query ? createSidebarLabelMatcher(query, options) : undefined;
  if (!matchLabel && searchableNodeTypes === undefined) return nodes;
  return filterSidebarTreeWithMatcher(nodes, matchLabel, collapsedIds, searchableNodeTypes);
}

export function reuseLiveSidebarTreeNodes(indexedNodes: TreeNode[], liveNodes: readonly TreeNode[]): TreeNode[] {
  const liveNodesById = new Map(liveNodes.map((node) => [node.id, node]));
  return indexedNodes.map((node) => liveNodesById.get(node.id) ?? node);
}

export interface SidebarRegexIndexScope {
  parentNodeId: string;
  connectionId: string;
  database: string;
  schema?: string;
  catalog?: string;
  nodeType: string;
  path?: Array<Pick<TreeNode, "id" | "label" | "type" | "connectionId" | "database" | "catalog" | "schema" | "linkedServer" | "linkedCatalog" | "linkedSchema">>;
  entries: TableInfo[];
}

/**
 * Composite identity of a regex index parent scope. TreeNode ids are not
 * unique across the whole tree (a database named "a:b" and a schema "b" under
 * a database "a" can both produce "connectionId:a:b"), so index lookups,
 * manifest backfills, and result merging must match on id plus the full
 * database context instead of the bare id.
 */
export interface SidebarRegexScopeIdentity {
  connectionId: string;
  database: string;
  schema?: string;
  catalog?: string;
  nodeType: string;
}

function identityFieldMatches(nodeValue: string | undefined, expected: string | undefined): boolean {
  return nodeValue === expected;
}

export function nodeMatchesRegexScopeIdentity(node: TreeNode, id: string, identity: SidebarRegexScopeIdentity): boolean {
  if (node.id !== id) return false;
  if (node.type !== identity.nodeType) return false;
  if (node.connectionId !== identity.connectionId) return false;
  // Connection roots deliberately carry no database scope; all actual index
  // parents below them must match every database-context field strictly.
  if (node.type === "connection") return true;
  if (!identityFieldMatches(node.database, identity.database)) return false;
  if (!identityFieldMatches(node.schema, identity.schema)) return false;
  if (!identityFieldMatches(node.catalog, identity.catalog)) return false;
  return true;
}

export function findNodePathByIdentity(nodes: readonly TreeNode[], id: string, identity: SidebarRegexScopeIdentity, ancestors: readonly TreeNode[] = []): readonly TreeNode[] | undefined {
  for (const node of nodes) {
    const path = [...ancestors, node];
    if (node.id === id) {
      // Same-id nodes can exist in different branches; only the one matching
      // the full database context counts as the target parent.
      if (nodeMatchesRegexScopeIdentity(node, id, identity)) return path;
      continue;
    }
    if (node.children) {
      const childPath = findNodePathByIdentity(node.children, id, identity, path);
      if (childPath) return childPath;
    }
  }
  return undefined;
}

function indexedTableChildren(scope: SidebarRegexIndexScope): TreeNode[] {
  // Reuse the regular table-node builder so index hits share live-node id
  // rules, normalized object types, name sorting, catalog/schema fields, and
  // partition parent/child nesting instead of hand-rolled node literals.
  return buildTableTreeNodes({
    nodeId: scope.parentNodeId,
    connectionId: scope.connectionId,
    database: scope.database,
    schema: scope.schema,
    catalog: scope.catalog,
    tables: scope.entries,
  });
}

function syntheticRegexParent(scope: SidebarRegexIndexScope): TreeNode {
  const snapshot = scope.path?.find((node) => node.id === scope.parentNodeId);
  return {
    id: scope.parentNodeId,
    label: snapshot?.label || (scope.nodeType === "group-tables" ? "tree.tables" : scope.schema || scope.database),
    type: (snapshot?.type || scope.nodeType) as TreeNodeType,
    connectionId: scope.connectionId,
    database: scope.database,
    schema: scope.schema,
    catalog: scope.catalog,
    ...(snapshot?.linkedServer ? { linkedServer: snapshot.linkedServer } : {}),
    ...(snapshot?.linkedCatalog ? { linkedCatalog: snapshot.linkedCatalog } : {}),
    ...(snapshot?.linkedSchema ? { linkedSchema: snapshot.linkedSchema } : {}),
    isExpanded: true,
    children: indexedTableChildren(scope),
  };
}

function pathNode(pathNode: NonNullable<SidebarRegexIndexScope["path"]>[number]): TreeNode {
  return { ...pathNode, isExpanded: true, children: [] };
}

function mergeRegexTreeNode(live: TreeNode | undefined, indexed: TreeNode): TreeNode {
  if (!live) return indexed;
  const children = mergeRegexTreeNodes(live.children ?? [], indexed.children ?? []);
  return children.length === (live.children ?? []).length && children.every((child, index) => child === live.children?.[index]) ? live : { ...live, children };
}

function mergeRegexTreeNodes(liveNodes: readonly TreeNode[], indexedNodes: readonly TreeNode[]): TreeNode[] {
  const byId = new Map(liveNodes.map((node) => [node.id, node]));
  const merged = [...liveNodes];
  for (const indexed of indexedNodes) {
    const existing = byId.get(indexed.id);
    if (existing) {
      const next = mergeRegexTreeNode(existing, indexed);
      if (next !== existing) merged[merged.indexOf(existing)] = next;
    } else {
      merged.push(indexed);
      byId.set(indexed.id, indexed);
    }
  }
  return merged;
}

/**
 * Add complete local-index results to a display-only tree. The live tree is
 * never mutated; existing nodes win identity/state, while missing connection,
 * database, schema, and table-group ancestors are synthesized from manifest
 * scope metadata. Duplicate table identities prefer the narrowest scope.
 */
export function mergeSidebarRegexIndexScopes(liveNodes: readonly TreeNode[], scopes: readonly SidebarRegexIndexScope[]): TreeNode[] {
  const selected = new Map<string, { rank: number; scope: SidebarRegexIndexScope; entry: TableInfo }>();
  const rankFor = (scope: SidebarRegexIndexScope) => (scope.nodeType === "group-tables" ? 3 : scope.nodeType === "schema" ? 2 : 1);
  for (const scope of scopes) {
    for (const entry of scope.entries) {
      const key = `${scope.connectionId}\0${scope.catalog || ""}\0${scope.database}\0${scope.schema || ""}\0${entry.table_type}\0${entry.name}`;
      const rank = rankFor(scope);
      if (!selected.has(key) || selected.get(key)!.rank < rank) selected.set(key, { rank, scope, entry });
    }
  }

  const scopeIdentity = (scope: SidebarRegexIndexScope): SidebarRegexScopeIdentity => ({
    connectionId: scope.connectionId,
    database: scope.database,
    schema: scope.schema,
    catalog: scope.catalog,
    nodeType: scope.nodeType,
  });
  const indexedRoots: TreeNode[] = [];
  const indexedRootIdentities = new Map<string, SidebarRegexScopeIdentity>();
  const anchoredParents: Array<{ node: TreeNode; identity: SidebarRegexScopeIdentity }> = [];
  const rootsById = new Map<string, TreeNode>();
  const ensureRoot = (id: string, label: string, type: TreeNodeType, scope: SidebarRegexIndexScope): TreeNode => {
    const existing = rootsById.get(id);
    if (existing) return existing;
    const created: TreeNode = { id, label, type, connectionId: scope.connectionId, database: scope.database, catalog: scope.catalog, isExpanded: true, children: [] };
    rootsById.set(id, created);
    indexedRoots.push(created);
    // The root is a connection: its database context does not apply to the
    // live connection node itself (it has no database field), so identity
    // matching compares id + type + connectionId.
    indexedRootIdentities.set(id, { ...scopeIdentity(scope), nodeType: "connection" });
    return created;
  };

  const grouped = new Map<string, SidebarRegexIndexScope>();
  for (const { scope, entry } of selected.values()) {
    const key = JSON.stringify([scope.parentNodeId, scope.connectionId, scope.database, scope.schema ?? null, scope.catalog ?? null, scope.nodeType]);
    const previous = grouped.get(key);
    if (previous) previous.entries.push(entry);
    else grouped.set(key, { ...scope, entries: [entry] });
  }

  const liveScopeParentExists = (scope: SidebarRegexIndexScope): boolean => !!findNodePathByIdentity(liveNodes, scope.parentNodeId, scopeIdentity(scope));

  for (const scope of grouped.values()) {
    const path = scope.path;
    if (!path) {
      // First-time backfill of an index that predates the manifest: merge the
      // entries directly into the live parent wherever the tree places it
      // (connection groups, Oracle/Dameng connection->schema, Doris catalogs,
      // SQL Server linked servers). Do not guess ancestors from the id.
      if (!liveScopeParentExists(scope)) continue;
      anchoredParents.push({ node: syntheticRegexParent(scope), identity: scopeIdentity(scope) });
      continue;
    }
    const connectionPath = path.find((node) => node.type === "connection");
    if (!connectionPath) continue;
    // A removed connection must never come back as a ghost result: manifest
    // scopes only render when their recorded connection is still in the tree.
    // Same-id lookups are disambiguated by the database context.
    if (!findNodePathByIdentity(liveNodes, connectionPath.id, { ...scopeIdentity(scope), nodeType: "connection" })) continue;
    const connection = ensureRoot(connectionPath.id, connectionPath.label, "connection", scope);
    let parent: TreeNode = connection;
    const ancestors = path.slice(path.findIndex((node) => node.type === "connection") + 1);
    for (const ancestor of ancestors) {
      if (ancestor.id === scope.parentNodeId) break;
      const next = (parent.children ?? []).find((child) => child.id === ancestor.id) ?? pathNode(ancestor);
      if (!parent.children?.some((child) => child.id === next.id)) parent.children = [...(parent.children ?? []), next];
      parent = next;
    }
    const scopeParent = syntheticRegexParent(scope);
    const existing = (parent.children ?? []).find((child) => child.id === scope.parentNodeId);
    parent.children = existing ? (parent.children ?? []).map((child) => (child.id === existing.id ? mergeRegexTreeNode(existing, scopeParent) : child)) : [...(parent.children ?? []), scopeParent];
  }

  let merged = [...liveNodes];
  // Same-id nodes can live in different branches (database "a:b" vs schema
  // "b" under database "a"), so every merge target is matched by id plus its
  // composite database context, never by the bare id.
  const mergeRoot = (nodes: readonly TreeNode[], indexed: TreeNode, identity: SidebarRegexScopeIdentity): { nodes: TreeNode[]; found: boolean } => {
    const direct = nodes.findIndex((node) => nodeMatchesRegexScopeIdentity(node, indexed.id, identity));
    if (direct >= 0) {
      return { nodes: nodes.map((node, index) => (index === direct ? mergeRegexTreeNode(node, indexed) : node)), found: true };
    }
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      if (!node.children) continue;
      const result = mergeRoot(node.children, indexed, identity);
      if (!result.found) continue;
      return { nodes: nodes.map((candidate, candidateIndex) => (candidateIndex === index ? { ...candidate, children: result.nodes } : candidate)), found: true };
    }
    return { nodes: [...nodes], found: false };
  };
  for (const indexed of indexedRoots) {
    const identity = indexedRootIdentities.get(indexed.id);
    const result = identity ? mergeRoot(merged, indexed, identity) : { nodes: merged, found: false };
    merged = result.found ? result.nodes : mergeRegexTreeNodes(merged, [indexed]);
  }
  for (const { node, identity } of anchoredParents) {
    const result = mergeRoot(merged, node, identity);
    if (result.found) merged = result.nodes;
  }
  return merged;
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
