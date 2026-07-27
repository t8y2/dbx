import type { KvKeySummary, KvValue } from "@/lib/backend/api";

export interface KvKeyTreeLeafNode {
  kind: "leaf";
  id: string;
  label: string;
  key: string;
  keyIdentity?: string | null;
  keyBytes?: KvValue | null;
  pathSegments: string[];
  createRevision?: string | number | null;
  modRevision?: string | number | null;
  version?: string | number | null;
  lease?: string | number | null;
  valueSize?: number | null;
}

export interface KvKeyTreeGroupNode {
  kind: "group";
  id: string;
  label: string;
  pathSegments: string[];
  children: KvKeyTreeNode[];
  key?: string;
  keyIdentity?: string | null;
  keyBytes?: KvValue | null;
  createRevision?: string | number | null;
  modRevision?: string | number | null;
  version?: string | number | null;
  lease?: string | number | null;
  valueSize?: number | null;
}

export type KvKeyTreeNode = KvKeyTreeLeafNode | KvKeyTreeGroupNode;

export interface KvKeyTreeRow {
  node: KvKeyTreeNode;
  depth: number;
}

function keySegments(key: string): string[] {
  return key.split("/").filter(Boolean);
}

function groupId(pathSegments: string[]): string {
  return `group:${pathSegments.join("\u0000")}`;
}

function summaryIdentity(key: KvKeySummary): string {
  return key.keyIdentity ?? key.key;
}

function leafId(key: KvKeySummary): string {
  return `leaf:${summaryIdentity(key)}`;
}

function sortNodes(nodes: KvKeyTreeNode[]): KvKeyTreeNode[] {
  return [...nodes]
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "group" ? -1 : 1;
      return a.label.localeCompare(b.label);
    })
    .map((node) => (node.kind === "group" ? { ...node, children: sortNodes(node.children) } : node));
}

export function buildKvKeyTree(keys: KvKeySummary[]): KvKeyTreeNode[] {
  const root: KvKeyTreeNode[] = [];
  const groups = new Map<string, KvKeyTreeGroupNode>();

  for (const key of keys) {
    const segments = keySegments(key.key);
    if (segments.length <= 1) {
      root.push({
        kind: "leaf",
        id: leafId(key),
        label: segments[0] || key.key || "/",
        key: key.key,
        keyIdentity: key.keyIdentity,
        keyBytes: key.keyBytes,
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
        const leafIndex = current.findIndex((candidate) => candidate.kind === "leaf" && candidate.pathSegments.join("\u0000") === groupSegments.join("\u0000"));
        const existingLeaf = leafIndex >= 0 ? (current.splice(leafIndex, 1)[0] as KvKeyTreeLeafNode) : null;
        group = {
          kind: "group",
          id,
          label: segment,
          pathSegments: [...groupSegments],
          children: [],
          key: existingLeaf?.key,
          keyIdentity: existingLeaf?.keyIdentity,
          keyBytes: existingLeaf?.keyBytes,
          createRevision: existingLeaf?.createRevision,
          modRevision: existingLeaf?.modRevision,
          version: existingLeaf?.version,
          lease: existingLeaf?.lease,
          valueSize: existingLeaf?.valueSize,
        };
        groups.set(id, group);
        current.push(group);
      }
      current = group.children;
    }

    const existingGroup = groups.get(groupId(segments));
    if (existingGroup) {
      existingGroup.key = key.key;
      existingGroup.keyIdentity = key.keyIdentity;
      existingGroup.keyBytes = key.keyBytes;
      existingGroup.createRevision = key.createRevision;
      existingGroup.modRevision = key.modRevision;
      existingGroup.version = key.version;
      existingGroup.lease = key.lease;
      existingGroup.valueSize = key.valueSize;
      continue;
    }

    current.push({
      kind: "leaf",
      id: leafId(key),
      label: segments[segments.length - 1],
      key: key.key,
      keyIdentity: key.keyIdentity,
      keyBytes: key.keyBytes,
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

export function collectKvGroupIds(nodes: KvKeyTreeNode[]): Set<string> {
  const ids = new Set<string>();
  const walk = (entries: KvKeyTreeNode[]) => {
    for (const node of entries) {
      if (node.kind !== "group") continue;
      ids.add(node.id);
      walk(node.children);
    }
  };
  walk(nodes);
  return ids;
}

export function preserveKvExpandedGroupIds(nodes: KvKeyTreeNode[], previous: ReadonlySet<string>, expandAll = false): Set<string> {
  const available = collectKvGroupIds(nodes);
  const next = new Set<string>();
  for (const id of expandAll ? available : previous) {
    if (available.has(id)) next.add(id);
  }
  return next;
}

export function flattenVisibleKvKeyTree(nodes: KvKeyTreeNode[], expandedGroupIds: ReadonlySet<string>, depth = 0): KvKeyTreeRow[] {
  const rows: KvKeyTreeRow[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.kind === "group" && expandedGroupIds.has(node.id)) {
      rows.push(...flattenVisibleKvKeyTree(node.children, expandedGroupIds, depth + 1));
    }
  }
  return rows;
}

export function kvKeyTreeNodePath(node: KvKeyTreeNode): string {
  if (node.kind === "leaf") return node.key;
  if (node.key) return node.key;

  const descendantKey = firstDescendantKey(node);
  const joined = node.pathSegments.join("/");
  return descendantKey?.startsWith("/") ? `/${joined}` : joined;
}

function firstDescendantKey(node: KvKeyTreeGroupNode): string | null {
  for (const child of node.children) {
    if (child.kind === "leaf") return child.key;
    if (child.key) return child.key;
    const nested = firstDescendantKey(child);
    if (nested) return nested;
  }
  return null;
}
