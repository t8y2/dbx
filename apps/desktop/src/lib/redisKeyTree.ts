import type { RedisKeyInfo } from "./api";

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
}

export type RedisKeyTreeNode = RedisKeyTreeLeafNode | RedisKeyTreeGroupNode;

export interface RedisKeyTreeRow {
  node: RedisKeyTreeNode;
  depth: number;
}

function buildGroupId(db: number, pathSegments: string[]): string {
  return `group:${db}:${pathSegments.join("\u0000")}`;
}

function buildLeafId(db: number, keyRaw: string): string {
  return `leaf:${db}:${keyRaw}`;
}

export function redisKeyToFlatTreeRow(key: RedisKeyInfo, db: number): RedisKeyTreeRow {
  return {
    node: {
      kind: "leaf",
      id: buildLeafId(db, key.key_raw),
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

function sortRedisTreeNodes(nodes: RedisKeyTreeNode[]): RedisKeyTreeNode[] {
  return [...nodes].sort(compareRedisTreeNodes).map((node) =>
    node.kind === "group"
      ? {
          ...node,
          children: sortRedisTreeNodes(node.children),
        }
      : node,
  );
}

export function buildRedisKeyTree(keys: RedisKeyInfo[], db: number, separator = ":"): RedisKeyTreeNode[] {
  const root: RedisKeyTreeNode[] = [];
  const groupMap = new Map<string, RedisKeyTreeGroupNode>();

  for (const key of keys) {
    insertKeyIntoTree(root, groupMap, key, db, separator);
  }

  return sortRedisTreeNodes(root);
}

function insertKeyIntoTree(root: RedisKeyTreeNode[], groupMap: Map<string, RedisKeyTreeGroupNode>, key: RedisKeyInfo, db: number, separator: string): void {
  const pathSegments = separator ? key.key_display.split(separator) : [key.key_display];
  if (pathSegments.length === 1) {
    root.push({
      kind: "leaf",
      id: buildLeafId(db, key.key_raw),
      label: pathSegments[0],
      fullKeyDisplay: key.key_display,
      keyRaw: key.key_raw,
      db,
      keyType: key.key_type ?? "",
      ttl: key.ttl ?? -2,
      size: key.size ?? 0,
      valuePreview: key.value_preview ?? "",
      pathSegments,
    });
    return;
  }

  let currentLevel = root;
  const groupSegments: string[] = [];
  for (const segment of pathSegments.slice(0, -1)) {
    groupSegments.push(segment);
    const groupId = buildGroupId(db, groupSegments);
    let group = groupMap.get(groupId);
    if (!group) {
      group = {
        kind: "group",
        id: groupId,
        label: segment,
        pathSegments: [...groupSegments],
        children: [],
      };
      groupMap.set(groupId, group);
      currentLevel.push(group);
    }
    currentLevel = group.children;
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
}

function rebuildGroupMap(tree: RedisKeyTreeNode[]): Map<string, RedisKeyTreeGroupNode> {
  const groupMap = new Map<string, RedisKeyTreeGroupNode>();

  const walk = (nodes: RedisKeyTreeNode[]) => {
    for (const node of nodes) {
      if (node.kind === "group") {
        groupMap.set(node.id, node);
        walk(node.children);
      }
    }
  };

  walk(tree);
  return groupMap;
}

export function mergeKeysIntoRedisKeyTree(existingTree: RedisKeyTreeNode[], newKeys: RedisKeyInfo[], db: number, separator = ":"): RedisKeyTreeNode[] {
  if (existingTree.length === 0) return buildRedisKeyTree(newKeys, db, separator);

  const groupMap = rebuildGroupMap(existingTree);
  const existingKeyIds = new Set<string>();
  const collectKeys = (nodes: RedisKeyTreeNode[]) => {
    for (const node of nodes) {
      if (node.kind === "leaf") {
        existingKeyIds.add(node.keyRaw);
      } else {
        collectKeys(node.children);
      }
    }
  };
  collectKeys(existingTree);

  for (const key of newKeys) {
    if (existingKeyIds.has(key.key_raw)) continue;
    insertKeyIntoTree(existingTree, groupMap, key, db, separator);
  }

  return sortRedisTreeNodes(existingTree);
}

export function collectExpandedGroupIds(nodes: RedisKeyTreeNode[]): Set<string> {
  const ids = new Set<string>();

  const visit = (entries: RedisKeyTreeNode[]) => {
    for (const node of entries) {
      if (node.kind !== "group") continue;
      ids.add(node.id);
      visit(node.children);
    }
  };

  visit(nodes);
  return ids;
}

export function collectRedisGroupKeyRaws(group: RedisKeyTreeGroupNode): string[] {
  const keyRaws: string[] = [];

  const visit = (nodes: RedisKeyTreeNode[]) => {
    for (const node of nodes) {
      if (node.kind === "leaf") {
        keyRaws.push(node.keyRaw);
      } else {
        visit(node.children);
      }
    }
  };

  visit(group.children);
  return keyRaws;
}

export function flattenVisibleRedisKeyTree(nodes: RedisKeyTreeNode[], expandedGroupIds: ReadonlySet<string>, depth = 0): RedisKeyTreeRow[] {
  const rows: RedisKeyTreeRow[] = [];
  const stack: RedisKeyTreeRow[] = [];

  for (let index = nodes.length - 1; index >= 0; index--) {
    stack.push({ node: nodes[index], depth });
  }

  while (stack.length > 0) {
    const row = stack.pop()!;
    rows.push(row);

    if (row.node.kind !== "group" || !expandedGroupIds.has(row.node.id)) continue;

    const childDepth = row.depth + 1;
    for (let index = row.node.children.length - 1; index >= 0; index--) {
      stack.push({ node: row.node.children[index], depth: childDepth });
    }
  }

  return rows;
}
