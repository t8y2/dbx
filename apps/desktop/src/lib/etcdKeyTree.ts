import type { KvKeySummary } from "./api";

export interface EtcdKeyTreeLeafNode {
  kind: "leaf";
  id: string;
  label: string;
  key: string;
  pathSegments: string[];
  createRevision?: number | null;
  modRevision?: number | null;
  version?: number | null;
  lease?: number | null;
  valueSize?: number | null;
}

export interface EtcdKeyTreeGroupNode {
  kind: "group";
  id: string;
  label: string;
  pathSegments: string[];
  children: EtcdKeyTreeNode[];
}

export type EtcdKeyTreeNode = EtcdKeyTreeLeafNode | EtcdKeyTreeGroupNode;

export interface EtcdKeyTreeRow {
  node: EtcdKeyTreeNode;
  depth: number;
}

function keySegments(key: string): string[] {
  return key.split("/").filter(Boolean);
}

function groupId(pathSegments: string[]): string {
  return `group:${pathSegments.join("\u0000")}`;
}

function leafId(key: string): string {
  return `leaf:${key}`;
}

function sortNodes(nodes: EtcdKeyTreeNode[]): EtcdKeyTreeNode[] {
  return [...nodes]
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "group" ? -1 : 1;
      return a.label.localeCompare(b.label);
    })
    .map((node) => (node.kind === "group" ? { ...node, children: sortNodes(node.children) } : node));
}

export function buildEtcdKeyTree(keys: KvKeySummary[]): EtcdKeyTreeNode[] {
  const root: EtcdKeyTreeNode[] = [];
  const groups = new Map<string, EtcdKeyTreeGroupNode>();

  for (const key of keys) {
    const segments = keySegments(key.key);
    if (segments.length <= 1) {
      root.push({
        kind: "leaf",
        id: leafId(key.key),
        label: segments[0] || key.key || "/",
        key: key.key,
        pathSegments: segments,
        createRevision: key.createRevision,
        modRevision: key.modRevision,
        version: key.version,
        lease: key.lease,
        valueSize: key.valueSize,
      });
      continue;
    }

    let current = root;
    const groupSegments: string[] = [];
    for (const segment of segments.slice(0, -1)) {
      groupSegments.push(segment);
      const id = groupId(groupSegments);
      let group = groups.get(id);
      if (!group) {
        group = { kind: "group", id, label: segment, pathSegments: [...groupSegments], children: [] };
        groups.set(id, group);
        current.push(group);
      }
      current = group.children;
    }

    current.push({
      kind: "leaf",
      id: leafId(key.key),
      label: segments[segments.length - 1],
      key: key.key,
      pathSegments: segments,
      createRevision: key.createRevision,
      modRevision: key.modRevision,
      version: key.version,
      lease: key.lease,
      valueSize: key.valueSize,
    });
  }

  return sortNodes(root);
}

export function collectEtcdGroupIds(nodes: EtcdKeyTreeNode[]): Set<string> {
  const ids = new Set<string>();
  const walk = (entries: EtcdKeyTreeNode[]) => {
    for (const node of entries) {
      if (node.kind !== "group") continue;
      ids.add(node.id);
      walk(node.children);
    }
  };
  walk(nodes);
  return ids;
}

export function flattenVisibleEtcdKeyTree(nodes: EtcdKeyTreeNode[], expandedGroupIds: ReadonlySet<string>, depth = 0): EtcdKeyTreeRow[] {
  const rows: EtcdKeyTreeRow[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.kind === "group" && expandedGroupIds.has(node.id)) {
      rows.push(...flattenVisibleEtcdKeyTree(node.children, expandedGroupIds, depth + 1));
    }
  }
  return rows;
}
