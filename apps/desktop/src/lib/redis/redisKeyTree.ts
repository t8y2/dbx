import type { RedisKeyInfo } from "@/lib/backend/api";

// A hierarchy duplicates key metadata and indexes; above this limit keep
// fuzzy results virtualized as flat rows instead of exhausting desktop memory.
export const REDIS_FUZZY_TREE_MAX_KEYS = 200_000;

export function canBuildRedisFuzzyTree(loadedKeyCount: number): boolean {
  return loadedKeyCount <= REDIS_FUZZY_TREE_MAX_KEYS;
}

export interface RedisKeyTreeLeafNode {
  kind: "leaf";
  id: string;
  label: string;
  fullKeyDisplay: string;
  keyRaw: string;
  db: number;
  keyType: string;
  ttl: number;
  size: number;
  valuePreview: string;
  pathSegments: string[];
}

export interface RedisKeyTreeGroupNode {
  kind: "group";
  id: string;
  label: string;
  pathSegments: string[];
  children: RedisKeyTreeNode[];
  // The rendered count must not recursively walk an entire visible subtree.
  loadedLeafCount: number;
}

export type RedisKeyTreeNode = RedisKeyTreeLeafNode | RedisKeyTreeGroupNode;

export interface RedisKeyTreeRow {
  id: string;
  node: RedisKeyTreeNode;
  depth: number;
}

export interface RedisKeyTreeIndex {
  root: RedisKeyTreeNode[];
  groupById: Map<string, RedisKeyTreeGroupNode>;
  leafByKeyRaw: Map<string, RedisKeyTreeLeafNode>;
  ancestorGroupIdsByKeyRaw: Map<string, readonly string[]>;
}

export interface AppendRedisKeysResult {
  addedGroupIds: Set<string>;
}

export interface RedisKeySnapshot {
  flatKeys: RedisKeyInfo[];
  flatKeyByRaw: Map<string, RedisKeyInfo>;
  loadedKeyRaws: Set<string>;
  filteredKeyCount: number;
  treeIndex: RedisKeyTreeIndex | null;
  expandedGroupIds: Set<string>;
  visibleRows: RedisKeyTreeRow[];
}

export interface CooperativeRedisKeySnapshotOptions {
  /** Maximum records handled before yielding back to the browser. */
  workChunkSize?: number;
  /** Production yields to a paint-capable browser turn; tests inject a deterministic scheduler. */
  yieldControl?: () => Promise<void>;
  /** Checked before work, after every yield, and before returning the completed snapshot. */
  shouldContinue?: () => boolean;
}

export function redisKeyNameCopyText(node: RedisKeyTreeNode): string | null {
  // keyRaw is base64-encoded for backend roundtrips; copy the user-visible
  // Redis key name instead of the internal transport value.
  return node.kind === "leaf" ? node.fullKeyDisplay : null;
}

function buildGroupId(db: number, pathSegments: string[]): string {
  return `group:${db}:${JSON.stringify(pathSegments)}`;
}

function buildLeafId(db: number, keyRaw: string): string {
  return `leaf:${db}:${keyRaw}`;
}

export function redisKeyToFlatTreeRow(key: RedisKeyInfo, db: number): RedisKeyTreeRow {
  const nodeId = buildLeafId(db, key.key_raw);
  return {
    id: nodeId,
    node: {
      kind: "leaf",
      id: nodeId,
      label: key.key_display,
      fullKeyDisplay: key.key_display,
      keyRaw: key.key_raw,
      db,
      keyType: key.key_type ?? "",
      ttl: key.ttl ?? -2,
      size: key.size ?? 0,
      valuePreview: key.value_preview ?? "",
      pathSegments: [key.key_display],
    },
    depth: 0,
  };
}

function compareRedisTreeNodes(a: RedisKeyTreeNode, b: RedisKeyTreeNode): number {
  if (a.kind !== b.kind) return a.kind === "group" ? -1 : 1;
  return a.label.localeCompare(b.label);
}

function defaultYieldControl(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

interface MutableTreeBuildState {
  index: RedisKeyTreeIndex;
  touchedLevels: Set<RedisKeyTreeNode[]>;
  addedGroupIds: Set<string>;
}

class CooperativeWorkController {
  private completedUnits = 0;

  constructor(
    readonly chunkSize: number,
    private readonly yieldControl: () => Promise<void>,
    private readonly shouldContinue: () => boolean,
  ) {}

  isActive(): boolean {
    return this.shouldContinue();
  }

  recordCompleted(units: number) {
    this.completedUnits += units;
  }

  needsYield(): boolean {
    return this.completedUnits >= this.chunkSize;
  }

  async yieldIfNeeded(): Promise<boolean> {
    if (!this.isActive()) return false;
    if (!this.needsYield()) return true;
    this.completedUnits = 0;
    await this.yieldControl();
    return this.isActive();
  }
}

function appendRedisKeyUnsorted(state: MutableTreeBuildState, key: RedisKeyInfo, db: number, separator: string) {
  const { index, touchedLevels, addedGroupIds } = state;
  if (index.leafByKeyRaw.has(key.key_raw)) return;

  const pathSegments = separator ? key.key_display.split(separator) : [key.key_display];
  const ancestorGroupIds: string[] = [];
  let currentLevel = index.root;

  if (pathSegments.length > 1) {
    const groupSegments: string[] = [];
    for (const segment of pathSegments.slice(0, -1)) {
      groupSegments.push(segment);
      const groupId = buildGroupId(db, groupSegments);
      let group = index.groupById.get(groupId);
      if (!group) {
        group = {
          kind: "group",
          id: groupId,
          label: segment,
          pathSegments: [...groupSegments],
          children: [],
          loadedLeafCount: 0,
        };
        index.groupById.set(groupId, group);
        currentLevel.push(group);
        touchedLevels.add(currentLevel);
        addedGroupIds.add(groupId);
      }
      group.loadedLeafCount++;
      ancestorGroupIds.push(groupId);
      currentLevel = group.children;
    }
  }

  const leaf: RedisKeyTreeLeafNode = {
    kind: "leaf",
    id: buildLeafId(db, key.key_raw),
    label: pathSegments[pathSegments.length - 1],
    fullKeyDisplay: key.key_display,
    keyRaw: key.key_raw,
    db,
    keyType: key.key_type ?? "",
    ttl: key.ttl ?? -2,
    size: key.size ?? 0,
    valuePreview: key.value_preview ?? "",
    pathSegments,
  };
  currentLevel.push(leaf);
  touchedLevels.add(currentLevel);
  index.leafByKeyRaw.set(key.key_raw, leaf);
  index.ancestorGroupIdsByKeyRaw.set(key.key_raw, ancestorGroupIds);
}

async function sortRedisTreeLevelCooperatively(nodes: RedisKeyTreeNode[], controller: CooperativeWorkController): Promise<boolean> {
  if (nodes.length < 2) {
    controller.recordCompleted(nodes.length);
    return controller.isActive();
  }

  let runs: RedisKeyTreeNode[][] = [];
  for (let offset = 0; offset < nodes.length; offset += controller.chunkSize) {
    if (!controller.isActive() || (controller.needsYield() && !(await controller.yieldIfNeeded()))) return false;
    const run = nodes.slice(offset, offset + controller.chunkSize);
    run.sort(compareRedisTreeNodes);
    runs.push(run);
    controller.recordCompleted(run.length);
  }

  while (runs.length > 1) {
    const mergedRuns: RedisKeyTreeNode[][] = [];
    for (let runIndex = 0; runIndex < runs.length; runIndex += 2) {
      const left = runs[runIndex];
      const right = runs[runIndex + 1];
      if (!right) {
        mergedRuns.push(left);
        continue;
      }

      const merged: RedisKeyTreeNode[] = [];
      merged.length = left.length + right.length;
      let leftIndex = 0;
      let rightIndex = 0;
      let outputIndex = 0;
      while (leftIndex < left.length || rightIndex < right.length) {
        if (!controller.isActive() || (controller.needsYield() && !(await controller.yieldIfNeeded()))) return false;
        const start = outputIndex;
        const end = Math.min(outputIndex + controller.chunkSize, merged.length);
        while (outputIndex < end) {
          if (rightIndex >= right.length || (leftIndex < left.length && compareRedisTreeNodes(left[leftIndex], right[rightIndex]) <= 0)) {
            merged[outputIndex++] = left[leftIndex++];
          } else {
            merged[outputIndex++] = right[rightIndex++];
          }
        }
        controller.recordCompleted(outputIndex - start);
      }
      mergedRuns.push(merged);
    }
    runs = mergedRuns;
  }

  const sorted = runs[0];
  for (let offset = 0; offset < sorted.length; offset += controller.chunkSize) {
    if (!controller.isActive() || (controller.needsYield() && !(await controller.yieldIfNeeded()))) return false;
    const end = Math.min(offset + controller.chunkSize, sorted.length);
    for (let index = offset; index < end; index++) nodes[index] = sorted[index];
    controller.recordCompleted(end - offset);
  }
  return controller.isActive();
}

async function flattenVisibleRedisKeyTreeCooperatively(nodes: RedisKeyTreeNode[], expandedGroupIds: ReadonlySet<string>, controller: CooperativeWorkController): Promise<RedisKeyTreeRow[] | null> {
  const rows: RedisKeyTreeRow[] = [];
  const stack: Array<{ nodes: RedisKeyTreeNode[]; nextIndex: number; depth: number }> = [{ nodes, nextIndex: 0, depth: 0 }];

  while (stack.length > 0) {
    if (!controller.isActive() || (controller.needsYield() && !(await controller.yieldIfNeeded()))) return null;
    const start = rows.length;
    const end = rows.length + controller.chunkSize;
    while (stack.length > 0 && rows.length < end) {
      const frame = stack[stack.length - 1];
      if (frame.nextIndex >= frame.nodes.length) {
        stack.pop();
        continue;
      }
      const node = frame.nodes[frame.nextIndex++];
      rows.push({ id: node.id, node, depth: frame.depth });
      if (node.kind === "group" && expandedGroupIds.has(node.id) && node.children.length > 0) {
        // Keep only a cursor for the child collection. Pushing every child of
        // one expanded million-key group would itself be an unbounded O(N)
        // task before the outer cooperative loop gets another yield point.
        stack.push({ nodes: node.children, nextIndex: 0, depth: frame.depth + 1 });
      }
    }
    controller.recordCompleted(rows.length - start);
  }
  return controller.isActive() ? rows : null;
}

/**
 * Builds the complete Fetch All snapshot without exposing partially-built
 * structures to Vue. Every linear stage is divided into bounded work units so
 * the browser can paint and dispatch input between them.
 */
export async function buildRedisKeySnapshotCooperatively(
  keyBatches: readonly (readonly RedisKeyInfo[])[],
  config: {
    db: number;
    separator?: string;
    flatRows: boolean;
    expandAll: boolean;
    expandedGroupIds: ReadonlySet<string>;
    noExpiryOnly?: boolean;
  },
  options: CooperativeRedisKeySnapshotOptions = {},
): Promise<RedisKeySnapshot | null> {
  const chunkSize = Math.max(1, options.workChunkSize ?? 25_000);
  const yieldControl = options.yieldControl ?? defaultYieldControl;
  const shouldContinue = options.shouldContinue ?? (() => true);
  const controller = new CooperativeWorkController(chunkSize, yieldControl, shouldContinue);
  const separator = config.separator ?? ":";
  if (!shouldContinue()) return null;

  const flatKeys: RedisKeyInfo[] = [];
  const flatKeyByRaw = new Map<string, RedisKeyInfo>();
  const loadedKeyRaws = new Set<string>();
  let filteredKeyCount = 0;
  const treeState: MutableTreeBuildState | null = config.flatRows
    ? null
    : {
        index: { root: [], groupById: new Map(), leafByKeyRaw: new Map(), ancestorGroupIdsByKeyRaw: new Map() },
        touchedLevels: new Set(),
        addedGroupIds: new Set(),
      };
  const filteredTreeState: MutableTreeBuildState | null =
    !config.flatRows && config.noExpiryOnly
      ? {
          index: { root: [], groupById: new Map(), leafByKeyRaw: new Map(), ancestorGroupIdsByKeyRaw: new Map() },
          touchedLevels: new Set(),
          addedGroupIds: new Set(),
        }
      : null;

  for (const batch of keyBatches) {
    for (let offset = 0; offset < batch.length; offset += chunkSize) {
      if (!controller.isActive() || (controller.needsYield() && !(await controller.yieldIfNeeded()))) return null;
      const end = Math.min(offset + chunkSize, batch.length);
      for (let index = offset; index < end; index++) {
        const key = batch[index];
        if (flatKeyByRaw.has(key.key_raw)) continue;
        flatKeyByRaw.set(key.key_raw, key);
        loadedKeyRaws.add(key.key_raw);
        flatKeys.push(key);
        if (!config.noExpiryOnly || key.ttl === -1) filteredKeyCount++;
        if (treeState) appendRedisKeyUnsorted(treeState, key, config.db, separator);
        if (filteredTreeState && key.ttl === -1) appendRedisKeyUnsorted(filteredTreeState, key, config.db, separator);
      }
      controller.recordCompleted(end - offset);
    }
  }

  for (const state of [treeState, filteredTreeState]) {
    if (!state) continue;
    for (const level of state.touchedLevels) {
      if (level.length <= controller.chunkSize) {
        if (!controller.isActive() || (controller.needsYield() && !(await controller.yieldIfNeeded()))) return null;
        if (level.length > 1) level.sort(compareRedisTreeNodes);
        controller.recordCompleted(level.length);
        continue;
      }
      if (!(await sortRedisTreeLevelCooperatively(level, controller))) return null;
    }
  }

  const treeIndex = treeState?.index ?? null;
  const expandedGroupIds = new Set<string>();
  if (treeIndex) {
    if (config.expandAll) {
      for (const id of treeIndex.groupById.keys()) {
        if (controller.needsYield() && !(await controller.yieldIfNeeded())) return null;
        expandedGroupIds.add(id);
        controller.recordCompleted(1);
      }
    } else {
      for (const id of config.expandedGroupIds) {
        if (controller.needsYield() && !(await controller.yieldIfNeeded())) return null;
        if (treeIndex.groupById.has(id)) expandedGroupIds.add(id);
        controller.recordCompleted(1);
      }
    }
  }

  let visibleRows: RedisKeyTreeRow[];
  if (config.flatRows) {
    visibleRows = [];
    for (let offset = 0; offset < flatKeys.length; offset += chunkSize) {
      if (!controller.isActive() || (controller.needsYield() && !(await controller.yieldIfNeeded()))) return null;
      const end = Math.min(offset + chunkSize, flatKeys.length);
      for (let index = offset; index < end; index++) {
        const key = flatKeys[index];
        if (!config.noExpiryOnly || key.ttl === -1) visibleRows.push(redisKeyToFlatTreeRow(key, config.db));
      }
      controller.recordCompleted(end - offset);
    }
  } else {
    const visibleTree = filteredTreeState?.index.root ?? treeIndex?.root ?? [];
    const rows = await flattenVisibleRedisKeyTreeCooperatively(visibleTree, expandedGroupIds, controller);
    if (!rows) return null;
    visibleRows = rows;
  }

  if (!shouldContinue()) return null;
  return { flatKeys, flatKeyByRaw, loadedKeyRaws, filteredKeyCount, treeIndex, expandedGroupIds, visibleRows };
}

function redisKeyInfoFromLeaf(node: RedisKeyTreeLeafNode): RedisKeyInfo {
  return {
    key_display: node.fullKeyDisplay,
    key_raw: node.keyRaw,
    key_type: node.keyType,
    ttl: node.ttl,
    size: node.size,
    value_preview: node.valuePreview,
  };
}

export function createRedisKeyTreeIndex(keys: readonly RedisKeyInfo[], db: number, separator = ":"): RedisKeyTreeIndex {
  const index: RedisKeyTreeIndex = {
    root: [],
    groupById: new Map(),
    leafByKeyRaw: new Map(),
    ancestorGroupIdsByKeyRaw: new Map(),
  };
  appendRedisKeysToTreeIndex(index, keys, db, separator);
  return index;
}

/**
 * Inserts one SCAN batch while sorting only sibling arrays changed by that
 * batch. This keeps repeated "load more" merges from re-sorting the full tree.
 */
export function appendRedisKeysToTreeIndex(index: RedisKeyTreeIndex, keys: readonly RedisKeyInfo[], db: number, separator = ":"): AppendRedisKeysResult {
  const state: MutableTreeBuildState = { index, touchedLevels: new Set(), addedGroupIds: new Set() };
  for (const key of keys) appendRedisKeyUnsorted(state, key, db, separator);
  for (const nodes of state.touchedLevels) nodes.sort(compareRedisTreeNodes);
  return { addedGroupIds: state.addedGroupIds };
}

/**
 * Refreshes metadata for an existing tree leaf without changing namespace
 * identity, hierarchy, ordering, or aggregate counts.
 */
export function updateRedisKeyTreeLeafMetadata(index: RedisKeyTreeIndex, key: RedisKeyInfo): boolean {
  const leaf = index.leafByKeyRaw.get(key.key_raw);
  if (!leaf) return false;

  leaf.keyType = key.key_type ?? "";
  leaf.ttl = key.ttl ?? -2;
  leaf.size = key.size ?? 0;
  leaf.valuePreview = key.value_preview ?? "";
  return true;
}

/**
 * Refreshes metadata on the canonical flat-list record through its identity
 * index. The existing object is retained so large shallow collections do not
 * need to be copied for a single-key refresh.
 */
export function updateRedisKeyInfoMetadataByRaw(keyByRaw: ReadonlyMap<string, RedisKeyInfo>, key: RedisKeyInfo): boolean {
  const existing = keyByRaw.get(key.key_raw);
  if (!existing) return false;

  existing.key_type = key.key_type;
  existing.ttl = key.ttl;
  existing.size = key.size;
  existing.value_preview = key.value_preview;
  return true;
}

export function buildRedisKeyTree(keys: RedisKeyInfo[], db: number, separator = ":"): RedisKeyTreeNode[] {
  return createRedisKeyTreeIndex(keys, db, separator).root;
}

export function mergeKeysIntoRedisKeyTree(existingTree: RedisKeyTreeNode[], newKeys: RedisKeyInfo[], db: number, separator = ":"): RedisKeyTreeNode[] {
  const existingKeys: RedisKeyInfo[] = [];
  const stack = [...existingTree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.kind === "leaf") {
      existingKeys.push(redisKeyInfoFromLeaf(node));
    } else {
      for (const child of node.children) stack.push(child);
    }
  }

  const index = createRedisKeyTreeIndex(existingKeys, db, separator);
  appendRedisKeysToTreeIndex(index, newKeys, db, separator);
  return index.root;
}

export function collectExpandedGroupIds(nodes: RedisKeyTreeNode[]): Set<string> {
  const ids = new Set<string>();
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.kind !== "group") continue;
    ids.add(node.id);
    for (const child of node.children) stack.push(child);
  }
  return ids;
}

export function collectRedisGroupKeyRaws(group: RedisKeyTreeGroupNode): string[] {
  const keyRaws: string[] = [];
  const stack = [...group.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.kind === "leaf") {
      keyRaws.push(node.keyRaw);
    } else {
      // Push in reverse so the iterative walk keeps the rendered tree order.
      for (let index = node.children.length - 1; index >= 0; index--) {
        stack.push(node.children[index]);
      }
    }
  }
  return keyRaws;
}

export function flattenVisibleRedisKeyTree(nodes: RedisKeyTreeNode[], expandedGroupIds: ReadonlySet<string>, depth = 0): RedisKeyTreeRow[] {
  const rows: RedisKeyTreeRow[] = [];
  const stack: RedisKeyTreeRow[] = [];

  for (let index = nodes.length - 1; index >= 0; index--) {
    stack.push({ id: nodes[index].id, node: nodes[index], depth });
  }

  while (stack.length > 0) {
    const row = stack.pop()!;
    rows.push(row);

    if (row.node.kind !== "group" || !expandedGroupIds.has(row.node.id)) continue;

    const childDepth = row.depth + 1;
    for (let index = row.node.children.length - 1; index >= 0; index--) {
      const child = row.node.children[index];
      stack.push({ id: child.id, node: child, depth: childDepth });
    }
  }

  return rows;
}
