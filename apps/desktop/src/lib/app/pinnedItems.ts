import type { TreeNode } from "@/types/database";

export type PinnedTreeNodeUpdateScope = "missing" | "root" | "siblings";
export type PinnedTreeNodeDropPosition = "before" | "after";
export type FixedTreeNodePriority = (node: TreeNode) => boolean;
export type PinnedTreeNodeIdentityCanonicalizer = (identity: PinnedTreeNodeIdentity) => PinnedTreeNodeIdentity;
export type PinnedTreeNodeIdentity = {
  connectionId: string;
  database: string;
  schema: string;
  catalog: string;
  type: TreeNode["type"];
  name: string;
  signature: string;
  id: string;
};

const NATURAL_TREE_NODE_ORDER = Symbol("naturalTreeNodeOrder");
type OrderedTreeNode = TreeNode & { [NATURAL_TREE_NODE_ORDER]?: number };

function naturalTreeNodeOrder(node: TreeNode): number | undefined {
  return (node as OrderedTreeNode)[NATURAL_TREE_NODE_ORDER];
}

function setNaturalTreeNodeOrder(node: TreeNode, order: number): void {
  // An enumerable symbol survives Vue proxies and object spreads while staying
  // out of persisted JSON, so rebuilt nodes retain their layout position.
  (node as OrderedTreeNode)[NATURAL_TREE_NODE_ORDER] = order;
}

export function inheritNaturalTreeNodeOrder(source: TreeNode, target: TreeNode): TreeNode {
  const order = naturalTreeNodeOrder(source);
  if (order !== undefined) setNaturalTreeNodeOrder(target, order);
  return target;
}

export function treeNodePinIdentity(node: TreeNode): PinnedTreeNodeIdentity {
  return {
    connectionId: node.connectionId || "",
    database: node.database || "",
    schema: node.schema || "",
    catalog: node.catalog || "",
    type: node.type,
    name: node.objectName || node.tableName || node.label,
    signature: node.signature || "",
    id: node.id,
  };
}

export function treeNodePinKey(node: TreeNode): string {
  if (!node.connectionId) return node.id;
  const identity = treeNodePinIdentity(node);
  const payload = [identity.database, identity.schema, identity.catalog, identity.type, identity.name, identity.signature, identity.id];
  return `${identity.connectionId}:pin:v2:${encodeURIComponent(JSON.stringify(payload))}`;
}

export function parseTreeNodePinKey(key: string): PinnedTreeNodeIdentity | null {
  const marker = ":pin:v2:";
  const markerIndex = key.indexOf(marker);
  if (markerIndex <= 0) return null;

  try {
    const payload = JSON.parse(decodeURIComponent(key.slice(markerIndex + marker.length)));
    if (!Array.isArray(payload) || payload.length !== 7 || payload.some((value) => typeof value !== "string")) return null;
    const [database, schema, catalog, type, name, signature, id] = payload;
    return { connectionId: key.slice(0, markerIndex), database, schema, catalog, type: type as TreeNode["type"], name, signature, id };
  } catch {
    return null;
  }
}

export function normalizePinnedTreeNodeOrder(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

export function pinnedTreeNodeIdentityMatches(left: PinnedTreeNodeIdentity, right: PinnedTreeNodeIdentity, canonicalize: PinnedTreeNodeIdentityCanonicalizer = (identity) => identity): boolean {
  const canonicalLeft = canonicalize(left);
  const canonicalRight = canonicalize(right);
  return (
    canonicalLeft.connectionId === canonicalRight.connectionId &&
    canonicalLeft.database === canonicalRight.database &&
    canonicalLeft.schema === canonicalRight.schema &&
    canonicalLeft.catalog === canonicalRight.catalog &&
    canonicalLeft.type === canonicalRight.type &&
    canonicalLeft.name === canonicalRight.name &&
    canonicalLeft.signature === canonicalRight.signature
  );
}

function pinnedTreeNodeOrderKeyMatchesNode(key: string, node: TreeNode, canonicalize: PinnedTreeNodeIdentityCanonicalizer, legacyKeys: ReadonlySet<string> = new Set()): boolean {
  if (key === treeNodePinKey(node) || key === node.id || legacyKeys.has(key)) return true;
  const identity = parseTreeNodePinKey(key);
  return !!identity && pinnedTreeNodeIdentityMatches(identity, treeNodePinIdentity(node), canonicalize);
}

export function removePinnedTreeNodesFromOrder(order: readonly string[], nodes: readonly TreeNode[], canonicalize: PinnedTreeNodeIdentityCanonicalizer = (identity) => identity, legacyKeys: readonly string[] = []): string[] {
  const removedKeys = new Set(legacyKeys);
  const removedIdentities: PinnedTreeNodeIdentity[] = [];
  const visited = new WeakSet<TreeNode>();
  const visit = (items: readonly TreeNode[]) => {
    for (const node of items) {
      if (visited.has(node)) continue;
      visited.add(node);
      // Remove the scoped key and any remaining legacy key. Keeping either lets
      // an object recreated with the same identity inherit a deleted pin.
      removedKeys.add(treeNodePinKey(node));
      removedKeys.add(node.id);
      removedIdentities.push(treeNodePinIdentity(node));
      if (node.children) visit(node.children);
      if (node.hiddenChildren) visit(node.hiddenChildren);
    }
  };

  visit(nodes);
  return normalizePinnedTreeNodeOrder(order).filter((key) => {
    if (removedKeys.has(key)) return false;
    const identity = parseTreeNodePinKey(key);
    return !identity || !removedIdentities.some((removed) => pinnedTreeNodeIdentityMatches(identity, removed, canonicalize));
  });
}

/** Replaces a pinned object identity in place after a successful rename. */
export function replacePinnedTreeNodeInOrder(order: readonly string[], oldNode: TreeNode, newNode: TreeNode, canonicalize: PinnedTreeNodeIdentityCanonicalizer = (identity) => identity, legacyKeys: readonly string[] = []): string[] {
  const normalized = normalizePinnedTreeNodeOrder(order);
  const legacyKeySet = new Set(legacyKeys);
  const oldIndex = normalized.findIndex((key) => pinnedTreeNodeOrderKeyMatchesNode(key, oldNode, canonicalize, legacyKeySet));
  if (oldIndex < 0) return normalized;

  const shouldRemove = (key: string) => pinnedTreeNodeOrderKeyMatchesNode(key, oldNode, canonicalize, legacyKeySet) || pinnedTreeNodeOrderKeyMatchesNode(key, newNode, canonicalize);
  const replacementIndex = normalized.slice(0, oldIndex).filter((key) => !shouldRemove(key)).length;
  const next = normalized.filter((key) => !shouldRemove(key));
  next.splice(replacementIndex, 0, treeNodePinKey(newNode));
  return normalizePinnedTreeNodeOrder(next);
}

export function migrateLegacyPinnedTreeNodeOrder(nodes: readonly TreeNode[], pinnedOrder: readonly string[]): { order: string[]; ids: Set<string>; changed: boolean } {
  const next = normalizePinnedTreeNodeOrder(pinnedOrder);
  let changed = next.length !== pinnedOrder.length;
  const visit = (items: readonly TreeNode[]) => {
    for (const node of items) {
      const pinKey = treeNodePinKey(node);
      const legacyIndex = pinKey === node.id ? -1 : next.indexOf(node.id);
      if (legacyIndex >= 0) {
        const scopedIndex = next.indexOf(pinKey);
        if (scopedIndex < 0) {
          // Replace in place so upgrading a legacy key never changes the user's
          // persisted order. A colliding legacy id is claimed by the first
          // matching loaded node, matching the previous migration behavior.
          next[legacyIndex] = pinKey;
        } else {
          next.splice(legacyIndex, 1);
        }
        changed = true;
      }
      if (node.children) visit(node.children);
      if (node.hiddenChildren) visit(node.hiddenChildren);
    }
  };
  visit(nodes);
  const order = normalizePinnedTreeNodeOrder(next);
  return { order, ids: new Set(order), changed: changed || order.length !== next.length };
}

export function migrateLegacyPinnedTreeNodeIds(nodes: readonly TreeNode[], pinnedIds: Set<string>): { ids: Set<string>; changed: boolean } {
  const migrated = migrateLegacyPinnedTreeNodeOrder(nodes, [...pinnedIds]);
  return { ids: migrated.ids, changed: migrated.changed };
}

export function reorderPinnedTreeNodeOrder(order: readonly string[], draggedKey: string, targetKey: string, position: PinnedTreeNodeDropPosition): string[] {
  const normalized = normalizePinnedTreeNodeOrder(order);
  if (draggedKey === targetKey || !normalized.includes(draggedKey) || !normalized.includes(targetKey)) return normalized;

  const next = normalized.filter((key) => key !== draggedKey);
  const targetIndex = next.indexOf(targetKey);
  next.splice(position === "before" ? targetIndex : targetIndex + 1, 0, draggedKey);
  return next;
}

export function orderPinnedFirst<T>(items: T[], isPinned: (item: T) => boolean): T[] {
  const pinned: T[] = [];
  const unpinned: T[] = [];

  for (const item of items) {
    if (isPinned(item)) pinned.push(item);
    else unpinned.push(item);
  }

  return [...pinned, ...unpinned];
}

function loadedTreeNodePinIdentities(nodes: readonly TreeNode[]): Map<string, PinnedTreeNodeIdentity> {
  const identities = new Map<string, PinnedTreeNodeIdentity>();
  const visited = new WeakSet<TreeNode>();
  const visit = (items: readonly TreeNode[]) => {
    for (const node of items) {
      if (visited.has(node)) continue;
      visited.add(node);
      const identity = treeNodePinIdentity(node);
      identities.set(treeNodePinKey(node), identity);
      if (!identities.has(node.id)) identities.set(node.id, identity);
      if (node.children) visit(node.children);
      if (node.hiddenChildren) visit(node.hiddenChildren);
    }
  };
  visit(nodes);
  return identities;
}

export function orderItemsByPinnedTreeNodeOrder<T>(items: readonly T[], pinnedOrder: readonly string[], matches: (item: T, identity: PinnedTreeNodeIdentity) => boolean, loadedNodes: readonly TreeNode[] = []): T[] {
  const normalizedOrder = normalizePinnedTreeNodeOrder(pinnedOrder);
  if (!items.length || !normalizedOrder.length) return [...items];

  let loadedIdentities: Map<string, PinnedTreeNodeIdentity> | undefined;
  const ranks: Array<number | undefined> = Array.from({ length: items.length });
  normalizedOrder.forEach((key, rank) => {
    const parsedIdentity = parseTreeNodePinKey(key);
    if (!parsedIdentity && !loadedIdentities) loadedIdentities = loadedTreeNodePinIdentities(loadedNodes);
    const identity = parsedIdentity ?? loadedIdentities?.get(key);
    if (!identity) return;
    items.forEach((item, index) => {
      if (ranks[index] === undefined && matches(item, identity)) ranks[index] = rank;
    });
  });

  const ranked: Array<{ item: T; index: number; rank: number }> = [];
  const unpinned: T[] = [];
  items.forEach((item, index) => {
    const rank = ranks[index];
    if (rank === undefined) unpinned.push(item);
    else ranked.push({ item, index, rank });
  });
  ranked.sort((left, right) => left.rank - right.rank || left.index - right.index);
  return [...ranked.map(({ item }) => item), ...unpinned];
}

function rememberNaturalTreeNodeOrder(nodes: readonly TreeNode[]): void {
  let nextOrder = 0;
  for (const node of nodes) {
    const order = naturalTreeNodeOrder(node);
    if (order === undefined) continue;
    nextOrder = Math.max(nextOrder, order + 1);
  }

  for (const node of nodes) {
    if (naturalTreeNodeOrder(node) !== undefined) continue;
    // Preserve the backend/layout order separately from the pinned presentation
    // order so an unpinned node can return to its original sibling position.
    setNaturalTreeNodeOrder(node, nextOrder++);
  }
}

export function orderPinnedTreeNodes(nodes: TreeNode[], pinnedOrder: readonly string[] = [], isFixedPriority: FixedTreeNodePriority = () => false): TreeNode[] {
  rememberNaturalTreeNodeOrder(nodes);
  const fixed: TreeNode[] = [];
  const pinned: TreeNode[] = [];
  const unpinned: TreeNode[] = [];
  const orderByKey = new Map(normalizePinnedTreeNodeOrder(pinnedOrder).map((key, index) => [key, index] as const));

  for (const node of nodes) {
    if (isFixedPriority(node)) fixed.push(node);
    else if (node.pinned) pinned.push(node);
    else unpinned.push(node);
  }

  const naturalOrder = (left: TreeNode, right: TreeNode) => naturalTreeNodeOrder(left)! - naturalTreeNodeOrder(right)!;
  fixed.sort(naturalOrder);
  pinned.sort((left, right) => {
    const leftRank = orderByKey.get(treeNodePinKey(left));
    const rightRank = orderByKey.get(treeNodePinKey(right));
    if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
    if (leftRank !== undefined) return -1;
    if (rightRank !== undefined) return 1;
    return naturalOrder(left, right);
  });
  unpinned.sort(naturalOrder);
  return [...fixed, ...pinned, ...unpinned];
}

function findTreeNodeLocation(nodes: TreeNode[], target: TreeNode, parent: TreeNode | null = null): { node: TreeNode; parent: TreeNode | null } | null {
  const targetKey = treeNodePinKey(target);
  for (const node of nodes) {
    if (node === target || treeNodePinKey(node) === targetKey) return { node, parent };
    if (node.children) {
      const found = findTreeNodeLocation(node.children, target, node);
      if (found) return found;
    }
  }
  return null;
}

export function updatePinnedTreeNodeInPlace(nodes: TreeNode[], target: TreeNode, pinned: boolean): PinnedTreeNodeUpdateScope {
  const location = findTreeNodeLocation(nodes, target);
  if (!location) return "missing";

  location.node.pinned = pinned;
  const siblings = location.parent?.children ?? nodes;
  const ordered = orderPinnedTreeNodes(siblings);

  if (location.parent) {
    location.parent.children = ordered;
    return "siblings";
  }

  nodes.splice(0, nodes.length, ...ordered);
  return "root";
}

function clonePinnedTreeNode(node: TreeNode, pinnedIds: Set<string>, pinnedOrder: readonly string[], isFixedPriority: FixedTreeNodePriority, clones: WeakMap<TreeNode, TreeNode>): TreeNode {
  const existing = clones.get(node);
  if (existing) return existing;
  const clone: TreeNode = {
    ...node,
    pinned: pinnedIds.has(treeNodePinKey(node)) || pinnedIds.has(node.id),
  };
  clones.set(node, clone);
  inheritNaturalTreeNodeOrder(node, clone);
  if (node.children) clone.children = applyPinnedTreeNodeStateInternal(node.children, pinnedIds, pinnedOrder, isFixedPriority, clones);
  if (node.hiddenChildren) clone.hiddenChildren = applyPinnedTreeNodeStateInternal(node.hiddenChildren, pinnedIds, pinnedOrder, isFixedPriority, clones);
  return clone;
}

function applyPinnedTreeNodeStateInternal(nodes: TreeNode[], pinnedIds: Set<string>, pinnedOrder: readonly string[], isFixedPriority: FixedTreeNodePriority, clones: WeakMap<TreeNode, TreeNode>): TreeNode[] {
  rememberNaturalTreeNodeOrder(nodes);
  return orderPinnedTreeNodes(
    nodes.map((node) => clonePinnedTreeNode(node, pinnedIds, pinnedOrder, isFixedPriority, clones)),
    pinnedOrder,
    isFixedPriority,
  );
}

export function applyPinnedTreeNodeState(nodes: TreeNode[], pinnedIds: Set<string>, pinnedOrder: readonly string[] = [...pinnedIds], isFixedPriority: FixedTreeNodePriority = () => false): TreeNode[] {
  return applyPinnedTreeNodeStateInternal(nodes, pinnedIds, pinnedOrder, isFixedPriority, new WeakMap());
}

function syncPinnedTreeNodeStateInPlaceInternal(nodes: TreeNode[], pinnedIds: Set<string>, pinnedOrder: readonly string[], isFixedPriority: FixedTreeNodePriority, visited: WeakSet<TreeNode>): void {
  for (const node of nodes) {
    if (visited.has(node)) continue;
    visited.add(node);
    node.pinned = pinnedIds.has(treeNodePinKey(node)) || pinnedIds.has(node.id);
    if (node.children) {
      syncPinnedTreeNodeStateInPlaceInternal(node.children, pinnedIds, pinnedOrder, isFixedPriority, visited);
      node.children = orderPinnedTreeNodes(node.children, pinnedOrder, isFixedPriority);
    }
    if (node.hiddenChildren) {
      syncPinnedTreeNodeStateInPlaceInternal(node.hiddenChildren, pinnedIds, pinnedOrder, isFixedPriority, visited);
      node.hiddenChildren = orderPinnedTreeNodes(node.hiddenChildren, pinnedOrder, isFixedPriority);
    }
  }
  nodes.splice(0, nodes.length, ...orderPinnedTreeNodes(nodes, pinnedOrder, isFixedPriority));
}

export function syncPinnedTreeNodeStateInPlace(nodes: TreeNode[], pinnedIds: Set<string>, pinnedOrder: readonly string[] = [...pinnedIds], isFixedPriority: FixedTreeNodePriority = () => false): void {
  syncPinnedTreeNodeStateInPlaceInternal(nodes, pinnedIds, pinnedOrder, isFixedPriority, new WeakSet());
}
