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
  keyRaws: Set<string>;
  ancestorGroupIdsByKeyRaw: Map<string, readonly string[]>;
}

export interface AppendRedisKeysResult {
  addedGroupIds: Set<string>;
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
    keyRaws: new Set(),
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
  const touchedLevels = new Set<RedisKeyTreeNode[]>();
  const addedGroupIds = new Set<string>();

  for (const key of keys) {
    if (index.keyRaws.has(key.key_raw)) continue;

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

    currentLevel.push({
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
    });
    touchedLevels.add(currentLevel);
    index.keyRaws.add(key.key_raw);
    index.ancestorGroupIdsByKeyRaw.set(key.key_raw, ancestorGroupIds);
  }

  for (const nodes of touchedLevels) nodes.sort(compareRedisTreeNodes);
  return { addedGroupIds };
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
