import type { KvKeyMetadata, KvKeySummary } from "@/lib/backend/api";

export interface LazyKvKeyTreeNode extends KvKeyMetadata {
  kind: "lazy";
  id: string;
  label: string;
  key: string;
  pathSegments: string[];
  /**
   * `null` means that a separator-based Consul listing returned a path ending
   * in `/`, so an exact GET is still required to distinguish a real Key from a
   * virtual prefix. ZooKeeper nodes and non-directory Consul Keys are known
   * values immediately.
   */
  hasValue: boolean | null;
  hasChildren: boolean;
  children: LazyKvKeyTreeNode[];
  loaded: boolean;
  loading: boolean;
  continuation: string | null;
}

export interface LazyKvKeyTreeState {
  pathStyle: LazyKvPathStyle;
  rootPath: string;
  roots: LazyKvKeyTreeNode[];
  rootContinuation: string | null;
  nodeByKey: Map<string, LazyKvKeyTreeNode>;
}

export type LazyKvPathStyle = "absolute" | "relative";

export type LazyKvKeySummary = KvKeySummary & { hasValue?: boolean | null };

export function lazyKvRootPath(pathStyle: LazyKvPathStyle): string {
  return pathStyle === "absolute" ? "/" : "";
}

export function normalizeLazyKvPath(path: string, pathStyle: LazyKvPathStyle): string {
  if (pathStyle === "absolute") return normalizeZooKeeperPath(path);
  return path.trim().replace(/^\/+/, "");
}

export function parentLazyKvPath(path: string, pathStyle: LazyKvPathStyle): string {
  if (pathStyle === "absolute") return parentZooKeeperPath(path);
  const normalized = normalizeLazyKvPath(path, pathStyle);
  const withoutTrailingSlash = normalized.replace(/\/+$/, "");
  const separator = withoutTrailingSlash.lastIndexOf("/");
  return separator < 0 ? "" : `${withoutTrailingSlash.slice(0, separator)}/`;
}

export function createLazyKvChildPathDraft(parentPath: string, pathStyle: LazyKvPathStyle): string {
  if (pathStyle === "absolute") return createZooKeeperChildPathDraft(parentPath);
  const normalized = normalizeLazyKvPath(parentPath, pathStyle);
  return normalized ? (normalized.endsWith("/") ? normalized : `${normalized}/`) : "";
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

export function createLazyKvKeyTreeState(rootPath = "/", pathStyle: LazyKvPathStyle = "absolute"): LazyKvKeyTreeState {
  return {
    pathStyle,
    rootPath: normalizeLazyKvPath(rootPath, pathStyle),
    roots: [],
    rootContinuation: null,
    nodeByKey: new Map(),
  };
}

export function resetLazyKvKeyTree(state: LazyKvKeyTreeState, rootPath = lazyKvRootPath(state.pathStyle)) {
  state.rootPath = normalizeLazyKvPath(rootPath, state.pathStyle);
  state.roots = [];
  state.rootContinuation = null;
  state.nodeByKey.clear();
}

export function replaceLazyKvChildren(state: LazyKvKeyTreeState, parentKey: string | null, keys: LazyKvKeySummary[], continuation: string | null | undefined, options: { append?: boolean; filteredByAcls?: boolean | null } = {}) {
  const previous = new Map(state.nodeByKey);
  const nextChildren = keys.map((key) => lazyNodeFromSummary(key, state.pathStyle, previous.get(key.key)));
  const children = options.append ? mergeLazyChildren(parentKey ? state.nodeByKey.get(parentKey)?.children || [] : state.roots, nextChildren) : nextChildren;

  if (parentKey) {
    const parent = state.nodeByKey.get(parentKey);
    if (!parent) return;
    parent.children = children;
    parent.loaded = true;
    parent.continuation = continuation || null;
    // A separator listing cannot initially distinguish a real `key/` from a
    // virtual directory. Once its complete, unfiltered child listing is empty,
    // it is known to be a leaf and must no longer render an expander.
    if (children.length > 0 || continuation) parent.hasChildren = true;
    else if (!options.filteredByAcls) parent.hasChildren = false;
  } else {
    state.roots = children;
    state.rootContinuation = continuation || null;
  }

  rebuildLazyNodeIndex(state);
}

export function replaceLazyKvFocusedRoot(state: LazyKvKeyTreeState, root: LazyKvKeySummary, keys: LazyKvKeySummary[], continuation: string | null | undefined) {
  const previous = new Map(state.nodeByKey);
  const focusedPath = normalizeLazyKvPath(root.key, state.pathStyle);
  const childNodes = keys.map((key) => lazyNodeFromSummary(key, state.pathStyle, previous.get(key.key)));
  const chain = focusedPathChain(focusedPath, state.pathStyle);
  let rootNode: LazyKvKeyTreeNode | null = null;
  let parentNode: LazyKvKeyTreeNode | null = null;

  for (const path of chain) {
    const isFocusedPath = path === focusedPath;
    const node = lazyNodeFromSummary(isFocusedPath ? { ...root, key: focusedPath } : { key: path, numChildren: 1, hasValue: false }, state.pathStyle, previous.get(path));
    // Ancestors are directories, but an exact focused Key with no children must
    // remain a leaf. Otherwise searching for that Key renders it as a folder.
    node.hasChildren = !isFocusedPath || (node.numChildren ?? 0) > 0;
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

function lazyNodeFromSummary(summary: LazyKvKeySummary, pathStyle: LazyKvPathStyle, previous?: LazyKvKeyTreeNode): LazyKvKeyTreeNode {
  const pathSegments = keySegments(summary.key);
  const hasValue = summary.hasValue !== undefined ? summary.hasValue : pathStyle === "absolute" || !summary.key.endsWith("/") ? true : (previous?.hasValue ?? null);
  return {
    ...summary,
    kind: "lazy",
    id: `lazy:${summary.key}`,
    label: pathSegments[pathSegments.length - 1] || summary.key || "/",
    key: summary.key,
    pathSegments,
    hasValue,
    hasChildren: (summary.numChildren ?? 0) > 0 || summary.key.endsWith("/"),
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

function focusedPathChain(path: string, pathStyle: LazyKvPathStyle): string[] {
  const segments = keySegments(path);
  const trailingSlash = pathStyle === "relative" && path.endsWith("/");
  const chain: string[] = [];
  for (let index = 0; index < segments.length; index++) {
    const joined = segments.slice(0, index + 1).join("/");
    const isLeaf = index === segments.length - 1;
    chain.push(pathStyle === "absolute" ? `/${joined}` : isLeaf && !trailingSlash ? joined : `${joined}/`);
  }
  return chain;
}
