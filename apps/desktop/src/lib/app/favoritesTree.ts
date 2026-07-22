import type { FavoriteGroup, FavoriteItem, FavoritesState, TreeNode } from "@/types/database";

/** Object kinds that can be added to a database's favorites. Materialized
 *  views share the same identity shape as views in the sidebar. */
const FAVORITABLE_NODE_TYPES: Set<TreeNode["type"]> = new Set(["table", "view", "materialized_view"]);

export function isFavoritableTreeNode(node: TreeNode): boolean {
  return FAVORITABLE_NODE_TYPES.has(node.type);
}

/** Build the stable identity key for a favoritable node. Uses a separate
 *  `fav:v1` prefix so favorites and pin state never collide in storage.
 *  Cloned items injected by the favorites controller carry a unique tree id
 *  to keep the virtual scroller happy; `favoritedFromId` preserves the
 *  original id so the favorite key stays stable. */
export function treeNodeFavoriteKey(node: TreeNode): string {
  if (!node.connectionId) return node.id;
  const stableId = node.favoritedFromId ?? node.id;
  const identity = [node.database || "", node.schema || "", node.catalog || "", node.type, node.objectName || node.tableName || node.label, node.signature || "", stableId];
  return `${node.connectionId}:fav:v1:${encodeURIComponent(JSON.stringify(identity))}`;
}

/** Empty state used when the user has never saved favorites, or after a
 *  migration that wiped out the old data. */
export function emptyFavoritesState(): FavoritesState {
  return { groups: [], items: [] };
}

/** Returns the default group id for a (connection, database) scope. The
 *  default group is lazily created on first use rather than pre-allocated,
 *  so an empty install never persists a phantom group. */
export function defaultGroupId(connectionId: string, database: string): string {
  return `${connectionId}::${database}::default`;
}

/** Look up the default group for a (connection, database) scope, or `null`
 *  if the user has explicitly deleted it. */
export function findDefaultGroup(state: FavoritesState, connectionId: string, database: string): FavoriteGroup | null {
  const id = defaultGroupId(connectionId, database);
  return state.groups.find((group) => group.id === id) ?? null;
}

/** Ensure the default group exists. Returns the (possibly new) group. */
export function ensureDefaultGroup(state: FavoritesState, connectionId: string, database: string): FavoriteGroup {
  const existing = findDefaultGroup(state, connectionId, database);
  if (existing) return existing;
  const group: FavoriteGroup = {
    id: defaultGroupId(connectionId, database),
    connectionId,
    database,
    name: "Default",
    order: 0,
    collapsed: false,
  };
  state.groups.push(group);
  return group;
}

/** Insert (or re-insert) a favorite item. If the key already exists its
 *  group/note/order are updated to the new values. */
export function upsertFavoriteItem(state: FavoritesState, key: string, groupId: string): FavoriteItem {
  const existing = state.items.find((item) => item.key === key);
  if (existing) {
    existing.groupId = groupId;
    return existing;
  }
  const maxOrder = state.items.reduce((max, item) => Math.max(max, item.order), -1);
  const item: FavoriteItem = {
    key,
    groupId,
    note: "",
    order: maxOrder + 1,
    createdAt: Date.now(),
  };
  state.items.push(item);
  return item;
}

/** Remove a favorite by key. Returns true if anything was removed. */
export function removeFavoriteItem(state: FavoritesState, key: string): boolean {
  const before = state.items.length;
  state.items = state.items.filter((item) => item.key !== key);
  return state.items.length !== before;
}

/** Returns items belonging to a group, sorted by their persisted `order`. */
export function listFavoritesForGroup(state: FavoritesState, groupId: string): FavoriteItem[] {
  return state.items
    .filter((item) => item.groupId === groupId)
    .slice()
    .sort((a, b) => a.order - b.order);
}

/** Returns items for a database (across all its groups), sorted by their
 *  persisted `order`. Used when the favorites group is rendered before
 *  sub-groups are visible. */
export function listFavoritesForDatabase(state: FavoritesState, connectionId: string, database: string): FavoriteItem[] {
  const groupIds = new Set(state.groups.filter((group) => group.connectionId === connectionId && group.database === database).map((group) => group.id));
  return state.items
    .filter((item) => groupIds.has(item.groupId))
    .slice()
    .sort((a, b) => a.order - b.order);
}

export interface CollectFavoritedTreeNodesOptions {
  /** Restrict the scan to nodes whose `connectionId` matches. */
  connectionId?: string;
  /** Restrict the scan to nodes whose `database` matches (case-sensitive). */
  database?: string;
}

/** Walks a tree (including hiddenChildren partitions) and returns cloned
 *  entries for every favorited key. Cloning keeps callers from accidentally
 *  showing the same object under two parents and lets them rewrite the
 *  children list freely.
 *
 *  Results are de-duplicated by favorite key. The sidebar tree intentionally
 *  re-references the same partition group from both `children` and
 *  `hiddenChildren` so collapsing the parent hides the partition rows
 *  without a re-layout, but that means a naive walk visits every child
 *  table twice. Without de-duplication, those tables would show up twice
 *  inside the Favorites placeholder. */
export function collectFavoritedTreeNodes(nodes: readonly TreeNode[], favoritedKeys: ReadonlySet<string>, options: CollectFavoritedTreeNodesOptions = {}): TreeNode[] {
  const result: TreeNode[] = [];
  const seen = new Set<string>();
  const visit = (items: readonly TreeNode[]) => {
    for (const node of items) {
      if (isFavoritableTreeNode(node)) {
        if (node.connectionId && options.connectionId && node.connectionId !== options.connectionId) {
          continue;
        }
        if (options.database !== undefined && (node.database ?? "") !== options.database) {
          continue;
        }
        const key = treeNodeFavoriteKey(node);
        if (favoritedKeys.has(key) && !seen.has(key)) {
          seen.add(key);
          result.push({ ...node, children: undefined, hiddenChildren: undefined });
        }
      }
      if (node.children) visit(node.children);
      if (node.hiddenChildren) visit(node.hiddenChildren);
    }
  };
  visit(nodes);
  return result;
}

/** Compute a fresh set of keys from the structured state, scoped to one
 *  database. Used by the tree builder so it never has to walk the structured
 *  state directly. */
export function favoritedKeysForDatabase(state: FavoritesState, connectionId: string, database: string): Set<string> {
  const groupIds = new Set(state.groups.filter((group) => group.connectionId === connectionId && group.database === database).map((group) => group.id));
  const keys = new Set<string>();
  for (const item of state.items) {
    if (groupIds.has(item.groupId)) keys.add(item.key);
  }
  return keys;
}

/** Re-index the `order` field for items in a group so it stays dense after
 *  deletes or reorders. Operates in place. */
export function reindexGroupOrder(state: FavoritesState, groupId: string): void {
  const items = state.items.filter((item) => item.groupId === groupId).sort((a, b) => a.order - b.order);
  items.forEach((item, index) => {
    item.order = index;
  });
}

/** Move a favorite to an explicit position within its group. `targetIndex` is
 *  zero-based and clamps to [0, groupSize - 1]; the resulting list is
 *  re-indexed densely. The dragged item's `groupId` is preserved. */
export function reorderFavoriteInGroup(state: FavoritesState, key: string, targetIndex: number): boolean {
  const item = state.items.find((entry) => entry.key === key);
  if (!item) return false;
  const siblings = state.items
    .filter((entry) => entry.groupId === item.groupId)
    .slice()
    .sort((a, b) => a.order - b.order);
  const fromIndex = siblings.findIndex((entry) => entry.key === key);
  if (fromIndex < 0) return false;
  const clamped = Math.max(0, Math.min(targetIndex, siblings.length - 1));
  if (fromIndex === clamped) return false;
  const [moved] = siblings.splice(fromIndex, 1);
  if (!moved) return false;
  siblings.splice(clamped, 0, moved);
  siblings.forEach((entry, index) => {
    entry.order = index;
  });
  return true;
}

/** Validate a loaded FavoritesState (defensive against corrupt cloud-sync
 *  snapshots or hand-edited files). Returns a sanitized state with default
 *  values filled in for any missing required fields. */
export function sanitizeFavoritesState(value: unknown): FavoritesState {
  const empty = emptyFavoritesState();
  if (!value || typeof value !== "object") return empty;
  const candidate = value as Partial<FavoritesState>;
  const groups: FavoriteGroup[] = Array.isArray(candidate.groups) ? candidate.groups.filter(isFavoriteGroup).map((group) => ({ ...group })) : [];
  const items: FavoriteItem[] = Array.isArray(candidate.items) ? candidate.items.filter(isFavoriteItem).map((item) => ({ ...item })) : [];
  return { groups, items };
}

function isFavoriteGroup(value: unknown): value is FavoriteGroup {
  if (!value || typeof value !== "object") return false;
  const group = value as Partial<FavoriteGroup>;
  return typeof group.id === "string" && typeof group.connectionId === "string" && typeof group.database === "string" && typeof group.name === "string" && typeof group.order === "number" && typeof group.collapsed === "boolean";
}

function isFavoriteItem(value: unknown): value is FavoriteItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<FavoriteItem>;
  return typeof item.key === "string" && typeof item.groupId === "string" && typeof item.note === "string" && typeof item.order === "number" && typeof item.createdAt === "number";
}
