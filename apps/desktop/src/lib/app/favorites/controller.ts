import { ref, type Ref } from "vue";
import { uuid } from "@/lib/common/utils";
import type { FavoriteGroup, FavoriteItem, FavoritesState, TreeNode } from "@/types/database";
import { collectFavoritedTreeNodes, decodeFavoriteKeyToStub, defaultGroupId, emptyFavoritesState, ensureDefaultGroup, isFavoritableTreeNode, reindexGroupOrder, removeFavoriteItem, reorderFavoriteInGroup, sanitizeFavoritesState, treeNodeFavoriteKey, upsertFavoriteItem } from "@/lib/app/favoritesTree";
import { buildFavoritesGroupSubnode } from "@/lib/table/tableTree";

/** Local-storage key the controller uses to cache the structured state. The
 *  remote backend (if any) is the source of truth on desktop; the local cache
 *  exists so the sidebar can render immediately before the first sync. */
export const FAVORITES_STATE_STORAGE_KEY = "dbx-favorites-state";

/** A side-effect-free load of the cached state from `localStorage`. Returns an
 *  empty state when the cache is missing or malformed. */
function loadFavoritesStateFromLocalStorage(): FavoritesState {
  if (typeof localStorage === "undefined") return emptyFavoritesState();
  try {
    const saved = localStorage.getItem(FAVORITES_STATE_STORAGE_KEY);
    if (!saved) return emptyFavoritesState();
    return sanitizeFavoritesState(JSON.parse(saved));
  } catch {
    return emptyFavoritesState();
  }
}

/** Persist a snapshot of the structured state to `localStorage`. Failures
 *  are intentionally swallowed: storage may be disabled (private browsing,
 *  quota exhausted) and the remote backend is still the source of truth. */
function persistFavoritesStateToLocalStorage(snapshot: FavoritesState): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(FAVORITES_STATE_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Quota errors and disabled storage are not fatal — the remote backend
    // remains the source of truth on desktop builds.
  }
}

export interface FavoritesControllerOptions {
  /** Tells the controller the desktop runtime is available so it can fetch
   *  the canonical state from the backend. When `false` the controller stays
   *  local-only (web preview, tests). */
  isDesktop: boolean;
  /** Reads the current canonical favorites state from the backend. Return
   *  `null` if the backend is unreachable or returns a non-object; the
   *  controller will sanitize the value before storing it and fall back to
   *  the local cache when the value is unusable. */
  loadRemote: () => Promise<unknown>;
}

/** A small set of hooks the controller calls back into after it mutates the
 *  structured state. The connection store implements them so the sidebar
 *  tree can be re-rendered and the canonical state is flushed to disk.
 *  Keeping them in an options bag lets the controller stay decoupled from
 *  pinia, the connection store, and the sidebar tree. */
export interface FavoritesControllerHooks {
  /** Persist the structured state to the local cache and (when available)
   *  the remote backend. */
  persist: (snapshot: FavoritesState) => void;
  /** Rebuild the favorites placeholder children in the current sidebar tree
   *  so users see their changes without a manual refresh. */
  refreshTree: () => void;
}

/** Owns the structured favorites state and the operations that mutate it.
 *  The controller is intentionally framework-agnostic: callers wire it up
 *  with a small set of hooks so it can stay independent of pinia and the
 *  sidebar tree. The tree itself is owned by the caller; the controller
 *  exposes `computePlaceholderChildren` so the caller can ask for the
 *  current children of any favorites placeholder without re-deriving the
 *  structured state. */
export class FavoritesController {
  private readonly _state: Ref<FavoritesState> = ref(emptyFavoritesState());
  private readonly options: FavoritesControllerOptions;
  private readonly hooks: FavoritesControllerHooks;
  private loaded = false;

  constructor(options: FavoritesControllerOptions, hooks: FavoritesControllerHooks) {
    this.options = options;
    this.hooks = hooks;
  }

  get state(): FavoritesState {
    return this._state.value;
  }

  get ref(): Ref<FavoritesState> {
    return this._state;
  }

  /** Read the canonical state from the backend (when available) and fall back
   *  to the local cache. Safe to call multiple times — only the first call
   *  triggers the remote fetch. The remote value is sanitized before being
   *  stored so a corrupt backend snapshot can never poison the local state. */
  async load(): Promise<FavoritesState> {
    if (this.loaded) return this._state.value;
    if (!this.options.isDesktop) {
      this._state.value = loadFavoritesStateFromLocalStorage();
      this.loaded = true;
      return this._state.value;
    }
    const remote = await this.options.loadRemote().catch(() => null);
    if (remote) {
      this._state.value = sanitizeFavoritesState(remote);
      persistFavoritesStateToLocalStorage(this._state.value);
    } else {
      this._state.value = loadFavoritesStateFromLocalStorage();
    }
    this.loaded = true;
    return this._state.value;
  }

  /** Replace the structured state. Used by the connection store when it
   *  finishes its initial remote sync and needs to push the canonical state
   *  back into the controller (e.g. after cloud-sync reconciliation). */
  setState(next: FavoritesState): void {
    this._state.value = sanitizeFavoritesState(next);
  }

  /** True when a key is present in the structured state. */
  isFavoritedKey(key: string): boolean {
    return this._state.value.items.some((entry) => entry.key === key);
  }

  /** True when a node is favorited; the string overload accepts the
   *  pre-computed favorite key. */
  isTreeNodeFavorited(node: TreeNode | string): boolean {
    if (typeof node === "string") return this.isFavoritedKey(node);
    return this.isFavoritedKey(treeNodeFavoriteKey(node));
  }

  /** Returns the persisted favorite key for a node, or `null` if it isn't
   *  currently favorited. */
  getFavoriteKeyForNode(node: TreeNode): string | null {
    if (!node.connectionId) return null;
    const key = treeNodeFavoriteKey(node);
    return this.isFavoritedKey(key) ? key : null;
  }

  /** Compute the favorite key for a tree node. Returns `null` when the node
   *  is not favoritable (wrong type or missing connectionId). */
  favoriteKeyForNode(node: TreeNode): string | null {
    if (!isFavoritableTreeNode(node) || !node.connectionId) return null;
    return treeNodeFavoriteKey(node);
  }

  /** Returns the stored note for a favorited key, or `null` if the key
   *  isn't favorited. */
  getFavoriteNote(key: string): string | null {
    return this._state.value.items.find((item) => item.key === key)?.note ?? null;
  }

  /** Returns the group a favorited key belongs to, or `null` if ungrouped. */
  getFavoriteGroupForKey(key: string): FavoriteGroup | null {
    const item = this._state.value.items.find((entry) => entry.key === key);
    if (!item) return null;
    return this._state.value.groups.find((group) => group.id === item.groupId) ?? null;
  }

  /** Returns a favorites group by id, or `null` if not found. */
  getFavoriteGroupById(groupId: string): FavoriteGroup | null {
    return this._state.value.groups.find((group) => group.id === groupId) ?? null;
  }

  /** All groups for one (connection, database) scope, sorted by `order`. */
  getFavoriteGroupsForDatabase(connectionId: string, database: string): FavoriteGroup[] {
    return this._state.value.groups
      .filter((group) => group.connectionId === connectionId && group.database === database)
      .slice()
      .sort((a, b) => a.order - b.order);
  }

  /** Siblings of `key` within its group, sorted by `order`. The `index` is
   *  -1 when the key is not present. */
  getFavoriteSiblingsForKey(key: string): { items: { key: string; order: number }[]; index: number } {
    const item = this._state.value.items.find((entry) => entry.key === key);
    if (!item) return { items: [], index: -1 };
    const items = this._state.value.items
      .filter((entry) => entry.groupId === item.groupId)
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((entry) => ({ key: entry.key, order: entry.order }));
    return { items, index: items.findIndex((entry) => entry.key === key) };
  }

  /** Returns the raw stored item for a favorite key, or `null` if missing. */
  getFavoriteItemForKey(key: string): FavoriteItem | null {
    return this._state.value.items.find((entry) => entry.key === key) ?? null;
  }

  /** Add the node to favorites (or remove it if already present). */
  toggleTreeNodeFavorite(node: TreeNode): boolean {
    if (!isFavoritableTreeNode(node) || !node.connectionId || node.database === undefined) return false;
    const key = treeNodeFavoriteKey(node);
    const existing = this._state.value.items.find((item) => item.key === key);
    if (existing) {
      removeFavoriteItem(this._state.value, key);
    } else {
      const group = ensureDefaultGroup(this._state.value, node.connectionId, node.database);
      upsertFavoriteItem(this._state.value, key, group.id);
    }
    this.flush();
    return !existing;
  }

  /** Add the node to a specific group. Returns false if the node is already
   *  favorited (use `moveFavoriteToGroup` to re-target instead).
   *
   *  If `groupId` matches the default group id for the node's scope and
   *  that group does not exist yet, it is lazily created so the item is
   *  never orphaned. This makes the "first time ever" code path safe to
   *  call without first going through `createFavoriteGroup`. */
  addFavoriteToGroup(node: TreeNode, groupId: string): boolean {
    if (!isFavoritableTreeNode(node)) return false;
    if (!node.connectionId || node.database === undefined) return false;
    const key = treeNodeFavoriteKey(node);
    if (this._state.value.items.some((item) => item.key === key)) return false;
    const isDefaultId = groupId === defaultGroupId(node.connectionId, node.database);
    const groupExists = this._state.value.groups.some((group) => group.id === groupId);
    if (isDefaultId && !groupExists) {
      ensureDefaultGroup(this._state.value, node.connectionId, node.database);
    }
    upsertFavoriteItem(this._state.value, key, groupId);
    this.flush();
    return true;
  }

  /** Remove a favorite by node or by pre-computed key. */
  removeFavorite(node: TreeNode | string): boolean {
    const key = typeof node === "string" ? node : treeNodeFavoriteKey(node);
    const removed = removeFavoriteItem(this._state.value, key);
    if (!removed) return false;
    this.flush();
    return true;
  }

  /** Update the user-editable note for a favorited key. */
  updateFavoriteNote(key: string, note: string): boolean {
    const item = this._state.value.items.find((entry) => entry.key === key);
    if (!item) return false;
    item.note = note;
    this.flush();
    return true;
  }

  /** Move a favorite to a different group; re-indexes the destination so the
   *  new ordering is dense. */
  moveFavoriteToGroup(key: string, groupId: string): boolean {
    const item = this._state.value.items.find((entry) => entry.key === key);
    if (!item) return false;
    if (!this._state.value.groups.some((group) => group.id === groupId)) return false;
    item.groupId = groupId;
    reindexGroupOrder(this._state.value, groupId);
    this.flush();
    return true;
  }

  /** Move an item within its group by one slot. `direction = -1` moves up. */
  shiftFavoriteOrder(key: string, direction: -1 | 1): boolean {
    const item = this._state.value.items.find((entry) => entry.key === key);
    if (!item) return false;
    const siblings = this._state.value.items
      .filter((entry) => entry.groupId === item.groupId)
      .slice()
      .sort((a, b) => a.order - b.order);
    const idx = siblings.findIndex((entry) => entry.key === key);
    const target = idx + direction;
    if (idx < 0 || target < 0 || target >= siblings.length) return false;
    const swap = siblings[target];
    if (!swap) return false;
    const tmp = item.order;
    item.order = swap.order;
    swap.order = tmp;
    this.flush();
    return true;
  }

  /** Move an item to the top or bottom of its group. */
  moveFavoriteToEdge(key: string, edge: "top" | "bottom"): boolean {
    const item = this._state.value.items.find((entry) => entry.key === key);
    if (!item) return false;
    const siblings = this._state.value.items
      .filter((entry) => entry.groupId === item.groupId)
      .slice()
      .sort((a, b) => a.order - b.order);
    const idx = siblings.findIndex((entry) => entry.key === key);
    if (idx < 0) return false;
    const target = edge === "top" ? 0 : siblings.length - 1;
    if (idx === target) return false;
    for (let i = 0; i < siblings.length; i += 1) {
      const sibling = siblings[i];
      if (!sibling) continue;
      sibling.order = i;
    }
    const [moved] = siblings.splice(idx, 1);
    if (!moved) return false;
    siblings.splice(target, 0, moved);
    siblings.forEach((entry, i) => {
      entry.order = i;
    });
    this.flush();
    return true;
  }

  /** Drag-and-drop reorder: place `key` at the explicit index within its
   *  current group. The list is re-indexed densely. */
  reorderFavorite(key: string, targetIndex: number): boolean {
    const moved = reorderFavoriteInGroup(this._state.value, key, targetIndex);
    if (!moved) return false;
    this.flush();
    return true;
  }

  /** Create a new named group inside one (connection, database) scope. */
  createFavoriteGroup(connectionId: string, database: string, name: string): FavoriteGroup {
    const trimmed = name.trim() || "New Group";
    const group: FavoriteGroup = {
      id: `${connectionId}::${database}::group-${uuid()}`,
      connectionId,
      database,
      name: trimmed,
      order: this._state.value.groups.filter((g) => g.connectionId === connectionId && g.database === database).length,
      collapsed: false,
    };
    this._state.value.groups.push(group);
    this.flush();
    return group;
  }

  /** Rename an existing group. */
  renameFavoriteGroup(groupId: string, name: string): boolean {
    const group = this._state.value.groups.find((entry) => entry.id === groupId);
    if (!group) return false;
    const trimmed = name.trim();
    if (!trimmed || trimmed === group.name) return false;
    group.name = trimmed;
    this.flush();
    return true;
  }

  /** Persist the collapsed/expanded state of a favorites group. */
  setFavoriteGroupCollapsed(groupId: string, collapsed: boolean): boolean {
    const group = this._state.value.groups.find((entry) => entry.id === groupId);
    if (!group) return false;
    if (group.collapsed === collapsed) return false;
    group.collapsed = collapsed;
    this.flush();
    return true;
  }

  /** Delete a group. The default group is never destroyed — items are
   *  re-homed under the lazily-created default of the same scope. */
  deleteFavoriteGroup(groupId: string): boolean {
    const group = this._state.value.groups.find((entry) => entry.id === groupId);
    if (!group) return false;
    if (group.id === defaultGroupId(group.connectionId, group.database)) return false;
    this._state.value.items = this._state.value.items.filter((item) => item.groupId !== groupId);
    const fallback = ensureDefaultGroup(this._state.value, group.connectionId, group.database);
    for (const item of this._state.value.items) {
      if (item.groupId === groupId) item.groupId = fallback.id;
    }
    reindexGroupOrder(this._state.value, fallback.id);
    this._state.value.groups = this._state.value.groups.filter((entry) => entry.id !== groupId);
    this.flush();
    return true;
  }

  /** Wipe every favorite in a (connection, database) scope. Returns the
   *  number of items removed so the caller can show a "Cleared N" toast. */
  clearFavoritesForDatabase(connectionId: string, database: string): number {
    const groupIds = new Set(this._state.value.groups.filter((group) => group.connectionId === connectionId && group.database === database).map((group) => group.id));
    const before = this._state.value.items.length;
    this._state.value.items = this._state.value.items.filter((item) => !groupIds.has(item.groupId));
    const removed = before - this._state.value.items.length;
    if (removed > 0) this.flush();
    return removed;
  }

  /** Compute the children of a favorites placeholder for a single
   *  (connection, database) scope. When the user has only the default group
   *  the items are returned flat (matching the pre-Phase-2 layout); when
   *  custom groups exist the items are bucketed under `favorites-group`
   *  subnodes. The result is suitable for direct assignment to a placeholder
   *  node's `children` field.
   *
   *  When the user has favorited items but the parent (database) children
   *  have not been loaded yet, the resolved table/view nodes are missing
   *  from `sourceTree`. We synthesize lightweight placeholder nodes from
   *  each key so the favorites group is never visually empty — the
   *  placeholder rows are replaced with real nodes the next time
   *  `computePlaceholderChildren` runs after the parent loads. */
  computePlaceholderChildren({ connectionId, database, schema, parentId, sourceTree }: { connectionId: string; database: string; schema?: string; parentId: string; sourceTree: readonly TreeNode[] }): { children: TreeNode[]; objectCount: number } {
    const state = this._state.value;
    const scopeGroups = state.groups.filter((group) => group.connectionId === connectionId && group.database === database);
    const scopeItems = state.items.filter((item) => scopeGroups.some((group) => group.id === item.groupId));
    const orderedGroups = scopeGroups.slice().sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));

    const keySet = new Set(scopeItems.map((item) => item.key));
    const collected = collectFavoritedTreeNodes(sourceTree, keySet, { connectionId, database });

    // Items in scope that did not resolve to a real source tree node. This
    // happens when the user has favorited tables/views inside a database
    // they have never expanded — the source tree has no child row to
    // back the key. Decode the structured key so we can render a stub
    // placeholder that names the (schema, object) pair.
    const collectedKeys = new Set(collected.map((node) => treeNodeFavoriteKey(node)));
    const missing = scopeItems.filter((item) => !collectedKeys.has(item.key));
    const missingNodes = missing.map((item) => decodeFavoriteKeyToStub(item.key, connectionId, database) ?? {
      id: `${parentId}::fav_missing::${item.key}`,
      label: "Unresolved favorite",
      type: "favorites-missing" as const,
      connectionId,
      database,
      isExpanded: false,
    });

    const groupIdByKey = new Map<string, string>();
    for (const item of scopeItems) groupIdByKey.set(item.key, item.groupId);
    const orderLookup = new Map<string, number>();
    for (const item of scopeItems) orderLookup.set(item.key, item.order);

    const childrenByGroup = new Map<string, TreeNode[]>();
    for (const group of orderedGroups) childrenByGroup.set(group.id, []);
    for (const child of [...collected, ...missingNodes]) {
      const key = treeNodeFavoriteKey(child);
      const groupId = groupIdByKey.get(key);
      if (!groupId) continue;
      const bucket = childrenByGroup.get(groupId);
      if (!bucket) continue;
      // Give the cloned item a unique tree id so it can co-exist with the
      // original table/view under the tables/views group in the flat tree
      // (issue: same id blanks the sibling rows in the virtual scroller).
      // The original id is preserved in `favoritedFromId` so the favorite
      // key stays stable across toggle/refresh.
      //
      // `child` may itself already be a previously-cloned node (carried
      // over from the last render of the placeholder). In that case its
      // own `favoritedFromId` is the real source id, and `child.id` is
      // already the synthetic clone id. Re-clobbering `favoritedFromId`
      // with `child.id` would replace the real id with the synthetic one
      // and break the `orderLookup` lookup below — every sorted pair
      // would then fall back to `label.localeCompare`, and the user's
      // manual order would silently reset to alphabetical.
      const stableSourceId = child.favoritedFromId ?? child.id;
      bucket.push({
        ...child,
        id: `${child.id}::fav_clone::${groupId}`,
        favoritedFromId: stableSourceId,
        children: undefined,
        hiddenChildren: undefined,
      });
    }
    for (const bucket of childrenByGroup.values()) {
      bucket.sort((left, right) => {
        const lo = orderLookup.get(treeNodeFavoriteKey(left));
        const ro = orderLookup.get(treeNodeFavoriteKey(right));
        if (lo !== undefined && ro !== undefined) return lo - ro;
        if (lo !== undefined) return -1;
        if (ro !== undefined) return 1;
        return left.label.localeCompare(right.label);
      });
    }

    const hasCustomGroups = orderedGroups.length > 1 || (orderedGroups[0] && orderedGroups[0].id !== defaultGroupId(connectionId, database));
    if (!hasCustomGroups) {
      const flat = childrenByGroup.get(orderedGroups[0]?.id ?? defaultGroupId(connectionId, database)) ?? [];
      return { children: flat, objectCount: flat.length };
    }
    const subnodes: TreeNode[] = [];
    for (const group of orderedGroups) {
      const items = childrenByGroup.get(group.id) ?? [];
      // Every group is rendered — including the default one when it's
      // empty — so the user always has a visible target when re-favoriting
      // an item. Hiding the empty default used to make it look like the
      // group had been deleted, with no way to add items back to it from
      // the sidebar.
      const subnode = buildFavoritesGroupSubnode({
        parentId,
        group: {
          id: group.id,
          name: group.name,
          connectionId: group.connectionId,
          database: group.database,
          schema,
          collapsed: group.collapsed,
        },
      });
      subnode.objectCount = items.length;
      subnode.children = items;
      subnodes.push(subnode);
    }
    return { children: subnodes, objectCount: scopeItems.length };
  }

  /** Persist the structured state through the registered hooks. */
  private flush(): void {
    this.hooks.persist(this._state.value);
    this.hooks.refreshTree();
  }

  /** Re-exported so callers can build the same key without re-importing the
   *  helper module. */
  static getFavoritesStateStorageKey(): string {
    return FAVORITES_STATE_STORAGE_KEY;
  }
}
