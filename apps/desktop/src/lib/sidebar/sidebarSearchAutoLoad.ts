import type { TreeNode, TreeNodeType } from "@/types/database";

/**
 * Sidebar global search filters the in-memory tree, so a database whose children
 * were never loaded contributes nothing to the match set. With many saved
 * connections the user had to expand every database by hand before a table name
 * could be found — the directory grew endlessly and the search looked broken.
 *
 * This module preloads exactly the levels that make table names searchable while
 * a query is active. Two properties matter as much as the loading itself:
 *
 * 1. The sidebar must look untouched once the query is cleared. Store loaders
 *    force a node open (so a user-driven expand reveals its children), which
 *    would leave every database expanded here — recreating the very "endless
 *    directory" problem. Auto-loaded nodes therefore keep their original
 *    expansion state.
 * 2. The work must stay bounded. A workspace with dozens of open connections
 *    would otherwise fire one metadata read per database simultaneously.
 */

/** Database-level containers whose children hold schemas or object groups. */
const AUTO_LOAD_CONTAINER_TYPES = new Set<TreeNodeType>(["database", "mongo-db", "vector-database"]);

/**
 * Grouped object display (the default) gives a database empty group
 * placeholders; the objects themselves arrive only when a group is loaded.
 * Only table-like groups are preloaded — procedures/functions/sequences would
 * multiply the metadata round-trips for little table-search benefit.
 */
const AUTO_LOAD_OBJECT_GROUP_TYPES = new Set<TreeNodeType>(["group-tables", "group-views", "group-materialized-views"]);

/**
 * Node types that only exist after an auto-load. When a search scope filter is
 * active and selects none of these (e.g. connection/database only), the loads
 * would be pure waste and are skipped.
 */
const AUTO_LOAD_REVEALED_TYPES: readonly TreeNodeType[] = ["schema", "table", "view", "materialized_view", "mongo-collection", "vector-collection", "elasticsearch-index"];

/** Small pool so a many-connection workspace does not stampede the backend. */
export const SIDEBAR_SEARCH_AUTO_LOAD_CONCURRENCY = 4;

/** container -> schema -> object group is the deepest chain search needs. */
export const SIDEBAR_SEARCH_AUTO_LOAD_MAX_ROUNDS = 3;

export type SidebarSearchAutoLoadKind = "container" | "schema" | "object-group";

/** Which auto-load stage a node belongs to, or null when it is not a target. */
export function sidebarSearchAutoLoadKind(node: TreeNode): SidebarSearchAutoLoadKind | null {
  if (AUTO_LOAD_CONTAINER_TYPES.has(node.type)) return node.database == null ? null : "container";
  if (node.type === "schema") return node.schema == null ? null : "schema";
  if (AUTO_LOAD_OBJECT_GROUP_TYPES.has(node.type)) return "object-group";
  return null;
}

export interface SidebarSearchAutoLoadState {
  isConnected(connectionId: string): boolean;
  isChildrenLoaded(nodeId: string): boolean;
}

/**
 * Collects every node that must be loaded before its objects can match the
 * query. Already-loaded nodes and disconnected connections are skipped, so a
 * repeat call after a load round naturally yields only the newly revealed level.
 */
export function collectSidebarSearchAutoLoadTargets(nodes: readonly TreeNode[], state: SidebarSearchAutoLoadState, skipNodeIds?: ReadonlySet<string>): TreeNode[] {
  const targets: TreeNode[] = [];

  const visit = (candidates: readonly TreeNode[]) => {
    for (const node of candidates) {
      // A disconnected connection has no live metadata to read; its stale
      // subtree is not worth walking.
      if (node.type === "connection" && node.connectionId && !state.isConnected(node.connectionId)) continue;
      if (node.connectionId && state.isConnected(node.connectionId) && !skipNodeIds?.has(node.id) && sidebarSearchAutoLoadKind(node) !== null && !state.isChildrenLoaded(node.id)) {
        targets.push(node);
      }
      if (node.children?.length) visit(node.children);
    }
  };

  visit(nodes);
  return targets;
}

/** Whether the active query (and optional scope filter) justifies preloading. */
export function shouldAutoLoadForSidebarSearch(query: string, searchableNodeTypes?: ReadonlySet<TreeNodeType>): boolean {
  if (!query.trim()) return false;
  if (!searchableNodeTypes) return true;
  return AUTO_LOAD_REVEALED_TYPES.some((nodeType) => searchableNodeTypes.has(nodeType));
}

export interface SidebarSearchAutoLoadOptions extends SidebarSearchAutoLoadState {
  /** Read through a getter: the store may swap the root array while loading. */
  getTreeNodes(): readonly TreeNode[];
  loadChildren(node: TreeNode): Promise<void>;
  /** Re-resolves a node after an await so expansion restore hits the live object. */
  liveNode?(nodeId: string): TreeNode | null;
  /** Superseded by a newer query, or the query was cleared. */
  isCancelled?(): boolean;
  concurrency?: number;
  maxRounds?: number;
}

export interface SidebarSearchAutoLoadResult {
  loadedNodeIds: string[];
  cancelled: boolean;
}

async function runWithConcurrencyLimit<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const workerCount = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const runners = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Loads collapsed-but-connected databases (and the schema / table-group levels
 * beneath them) so the global filter can match table names without the user
 * expanding anything. Errors are per-node and swallowed: one unreachable
 * database must never break search for the rest.
 */
export async function runSidebarSearchAutoLoad(options: SidebarSearchAutoLoadOptions): Promise<SidebarSearchAutoLoadResult> {
  const { getTreeNodes, loadChildren, liveNode, isCancelled, concurrency = SIDEBAR_SEARCH_AUTO_LOAD_CONCURRENCY, maxRounds = SIDEBAR_SEARCH_AUTO_LOAD_MAX_ROUNDS } = options;
  const isStale = () => isCancelled?.() === true;
  const attemptedNodeIds = new Set<string>();
  const loadedNodeIds: string[] = [];

  for (let round = 0; round < maxRounds; round += 1) {
    if (isStale()) return { loadedNodeIds, cancelled: true };

    const targets = collectSidebarSearchAutoLoadTargets(getTreeNodes(), options, attemptedNodeIds);
    if (targets.length === 0) break;
    // Recorded up front so a node that fails (or is already in flight) is never
    // retried in a later round, which would otherwise loop until maxRounds.
    for (const target of targets) attemptedNodeIds.add(target.id);

    await runWithConcurrencyLimit(targets, concurrency, async (node) => {
      if (isStale()) return;
      const wasExpanded = node.isExpanded === true;
      try {
        await loadChildren(node);
        loadedNodeIds.push(node.id);
      } catch {
        // Ignored on purpose: search degrades to the reachable databases.
      } finally {
        if (!wasExpanded) {
          const live = liveNode?.(node.id) ?? node;
          live.isExpanded = false;
        }
      }
    });
  }

  return { loadedNodeIds, cancelled: isStale() };
}
