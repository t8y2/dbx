import type { KvKeyMetadata, KvKeySummary } from "@/lib/backend/api";

export interface LazyKvKeyTreeNode extends KvKeyMetadata {
  kind: "lazy";
  id: string;
  label: string;
  key: string;
  pathSegments: string[];
  hasChildren: boolean;
  children: LazyKvKeyTreeNode[];
  loaded: boolean;
  loading: boolean;
  continuation: string | null;
}

export interface LazyKvKeyTreeState {
  rootPath: string;
  roots: LazyKvKeyTreeNode[];
  rootContinuation: string | null;
  nodeByKey: Map<string, LazyKvKeyTreeNode>;
}

export type LazyKvKeyTreeRow =
  | {
      type: "node";
      node: LazyKvKeyTreeNode;
      depth: number;
    }
  | {
      type: "loadMore";
      id: string;
      parentKey: string | null;
      depth: number;
      loading: boolean;
    };

export function normalizeZooKeeperPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "") || "/";
}

export function parentZooKeeperPath(path: string): string {
  const normalized = normalizeZooKeeperPath(path);
  if (normalized === "/") return "/";
  const parent = normalized.slice(0, normalized.lastIndexOf("/"));
  return parent || "/";
}

export function createZooKeeperChildPathDraft(parentPath: string): string {
  const normalized = normalizeZooKeeperPath(parentPath);
  if (normalized === "/") return "";
  return `${normalized}/`;
}

export function createLazyKvKeyTreeState(rootPath = "/"): LazyKvKeyTreeState {
  return {
    rootPath: normalizeZooKeeperPath(rootPath),
    roots: [],
    rootContinuation: null,
    nodeByKey: new Map(),
  };
}

export function resetLazyKvKeyTree(state: LazyKvKeyTreeState, rootPath = "/") {
  state.rootPath = normalizeZooKeeperPath(rootPath);
  state.roots = [];
  state.rootContinuation = null;
  state.nodeByKey.clear();
}

export function replaceLazyKvChildren(state: LazyKvKeyTreeState, parentKey: string | null, keys: KvKeySummary[], continuation: string | null | undefined, options: { append?: boolean } = {}) {
  const previous = new Map(state.nodeByKey);
  const nextChildren = keys.map((key) => lazyNodeFromSummary(key, previous.get(key.key)));
  const children = options.append ? mergeLazyChildren(parentKey ? state.nodeByKey.get(parentKey)?.children || [] : state.roots, nextChildren) : nextChildren;

  if (parentKey) {
    const parent = state.nodeByKey.get(parentKey);
    if (!parent) return;
    parent.children = children;
    parent.loaded = true;
    parent.continuation = continuation || null;
  } else {
    state.roots = children;
    state.rootContinuation = continuation || null;
  }

  rebuildLazyNodeIndex(state);
}

export function replaceLazyKvFocusedRoot(state: LazyKvKeyTreeState, root: KvKeySummary, keys: KvKeySummary[], continuation: string | null | undefined) {
  const previous = new Map(state.nodeByKey);
  const focusedPath = normalizeZooKeeperPath(root.key);
  const childNodes = keys.map((key) => lazyNodeFromSummary(key, previous.get(key.key)));
  const chain = focusedPathChain(focusedPath);
  let rootNode: LazyKvKeyTreeNode | null = null;
  let parentNode: LazyKvKeyTreeNode | null = null;

  for (const path of chain) {
    const node = lazyNodeFromSummary(path === focusedPath ? { ...root, key: focusedPath } : { key: path, numChildren: 1 }, previous.get(path));
    node.hasChildren = true;
    node.loaded = true;
    node.continuation = null;
    node.children = [];

    if (parentNode) parentNode.children = [node];
    else rootNode = node;
    parentNode = node;
  }

  if (parentNode) {
    parentNode.children = childNodes;
    parentNode.hasChildren = parentNode.hasChildren || childNodes.length > 0 || !!continuation;
    parentNode.continuation = continuation || null;
  }

  state.roots = rootNode ? [rootNode] : [];
  state.rootContinuation = null;
  rebuildLazyNodeIndex(state);
}

export function flattenLazyKvKeyTree(state: LazyKvKeyTreeState, expandedIds: ReadonlySet<string>): LazyKvKeyTreeRow[] {
  const rows = flattenLazyNodes(state.roots, expandedIds, 0);
  if (state.rootContinuation) {
    rows.push({ type: "loadMore", id: "lazy-load-more:root", parentKey: null, depth: 0, loading: false });
  }
  return rows;
}

export function lazyExpandedKeyFromId(id: string): string | null {
  return id.startsWith("lazy:") ? id.slice("lazy:".length) : null;
}

function flattenLazyNodes(nodes: LazyKvKeyTreeNode[], expandedIds: ReadonlySet<string>, depth: number): LazyKvKeyTreeRow[] {
  const rows: LazyKvKeyTreeRow[] = [];
  for (const node of nodes) {
    rows.push({ type: "node", node, depth });
    if (node.hasChildren && expandedIds.has(node.id)) {
      rows.push(...flattenLazyNodes(node.children, expandedIds, depth + 1));
      if (node.continuation) {
        rows.push({ type: "loadMore", id: `lazy-load-more:${node.key}`, parentKey: node.key, depth: depth + 1, loading: node.loading });
      }
    }
  }
  return rows;
}

function lazyNodeFromSummary(summary: KvKeySummary, previous?: LazyKvKeyTreeNode): LazyKvKeyTreeNode {
  const pathSegments = keySegments(summary.key);
  return {
    ...summary,
    kind: "lazy",
    id: `lazy:${summary.key}`,
    label: pathSegments[pathSegments.length - 1] || summary.key || "/",
    key: summary.key,
    pathSegments,
    hasChildren: (summary.numChildren ?? 0) > 0,
    children: previous?.children || [],
    loaded: previous?.loaded || false,
    loading: previous?.loading || false,
    continuation: previous?.continuation || null,
  };
}

function mergeLazyChildren(existing: LazyKvKeyTreeNode[], incoming: LazyKvKeyTreeNode[]): LazyKvKeyTreeNode[] {
  const seen = new Set(existing.map((node) => node.key));
  return [...existing, ...incoming.filter((node) => !seen.has(node.key))];
}

function rebuildLazyNodeIndex(state: LazyKvKeyTreeState) {
  state.nodeByKey.clear();
  const visit = (nodes: LazyKvKeyTreeNode[]) => {
    for (const node of nodes) {
      state.nodeByKey.set(node.key, node);
      visit(node.children);
    }
  };
  visit(state.roots);
}

function keySegments(key: string): string[] {
  return key.split("/").filter(Boolean);
}

function focusedPathChain(path: string): string[] {
  const segments = keySegments(path);
  const chain: string[] = [];
  for (let index = 0; index < segments.length; index++) {
    chain.push(`/${segments.slice(0, index + 1).join("/")}`);
  }
  return chain;
}
