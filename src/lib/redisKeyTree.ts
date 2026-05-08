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

export function buildRedisKeyTree(keys: RedisKeyInfo[], db: number): RedisKeyTreeNode[] {
  const root: RedisKeyTreeNode[] = [];
  const groupMap = new Map<string, RedisKeyTreeGroupNode>();

  for (const key of keys) {
    const pathSegments = key.key_display.split(":");
    if (pathSegments.length === 1) {
      root.push({
        kind: "leaf",
        id: buildLeafId(db, key.key_raw),
        label: pathSegments[0],
        fullKeyDisplay: key.key_display,
        keyRaw: key.key_raw,
        db,
        keyType: key.key_type,
        ttl: key.ttl,
        pathSegments,
      });
      continue;
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
      keyType: key.key_type,
      ttl: key.ttl,
      pathSegments,
    });
  }

  return sortRedisTreeNodes(root);
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

export function flattenVisibleRedisKeyTree(
  nodes: RedisKeyTreeNode[],
  expandedGroupIds: ReadonlySet<string>,
  depth = 0,
): RedisKeyTreeRow[] {
  const rows: RedisKeyTreeRow[] = [];

  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.kind === "group" && expandedGroupIds.has(node.id)) {
      rows.push(...flattenVisibleRedisKeyTree(node.children, expandedGroupIds, depth + 1));
    }
  }

  return rows;
}
