import type { AdminScope, ScopeTreeNode } from "@/lib/admin/adminApi";

export type ScopeNodeState = "checked" | "indeterminate" | "unchecked";

export interface ScopeTreeRow {
  node: ScopeTreeNode;
  depth: number;
}

/** 一对 ID 集合的读取视图：可见性与写入授权共用同一套树状态语义。 */
interface ScopeSelection {
  groupIds: readonly string[];
  connectionIds: readonly string[];
}

const VIEW_KEYS = { group: "allowed_group_ids", connection: "allowed_connection_ids" } as const;
const WRITE_KEYS = { group: "query_write_group_ids", connection: "query_write_connection_ids" } as const;

function selectionOf(scope: AdminScope, keys: typeof VIEW_KEYS | typeof WRITE_KEYS): ScopeSelection {
  if (keys.group === "query_write_group_ids") {
    return { groupIds: scope.query_write_group_ids ?? [], connectionIds: scope.query_write_connection_ids ?? [] };
  }
  return { groupIds: scope.allowed_group_ids, connectionIds: scope.allowed_connection_ids };
}

function nodeStateIn(selection: ScopeSelection, node: ScopeTreeNode, inherited = false): ScopeNodeState {
  if (inherited) return "checked";
  if (node.type === "connection") return selection.connectionIds.includes(node.id) ? "checked" : "unchecked";
  if (selection.groupIds.includes(node.id)) return "checked";

  const children = node.children ?? [];
  if (children.length === 0) return "unchecked";
  const states = children.map((child) => nodeStateIn(selection, child));
  if (states.every((state) => state === "checked")) return "checked";
  if (states.some((state) => state !== "unchecked")) return "indeterminate";
  return "unchecked";
}

function nodeStateInTree(nodes: readonly ScopeTreeNode[], selection: ScopeSelection, type: ScopeTreeNode["type"], id: string): ScopeNodeState {
  const path = findNodePath(nodes, type, id);
  if (!path) return "unchecked";
  const inherited = path.slice(0, -1).some((node) => node.type === "group" && selection.groupIds.includes(node.id));
  return nodeStateIn(selection, path[path.length - 1]!, inherited);
}

export function scopeNodeState(node: ScopeTreeNode, scope: AdminScope, inherited = false): ScopeNodeState {
  return nodeStateIn(selectionOf(scope, VIEW_KEYS), node, inherited);
}

export function scopeNodeStateInTree(nodes: readonly ScopeTreeNode[], scope: AdminScope, type: ScopeTreeNode["type"], id: string): ScopeNodeState {
  return nodeStateInTree(nodes, selectionOf(scope, VIEW_KEYS), type, id);
}

/** 写入授权的节点状态：与可见性同一套树语义，读 `query_write_*` 集合。 */
export function queryWriteNodeStateInTree(nodes: readonly ScopeTreeNode[], scope: AdminScope, type: ScopeTreeNode["type"], id: string): ScopeNodeState {
  return nodeStateInTree(nodes, selectionOf(scope, WRITE_KEYS), type, id);
}

export function toggleScopeNode(nodes: readonly ScopeTreeNode[], scope: AdminScope, type: ScopeTreeNode["type"], id: string): AdminScope {
  const next = toggleSelection(nodes, scope, type, id, VIEW_KEYS);
  // 不变量：写入授权 ⊆ 可见性。取消可见后，直接挂在连接上的写入授权同步收回
  // （分组级授权保留——后端写入判定先校验可见性，不会因此越权）。
  return pruneConnectionWritesOutsideVisibility(nodes, next);
}

/** 切换连接/分组的"可写"授权（写入查询的连接级授权）；可见性集合不变。 */
export function toggleWriteScopeNode(nodes: readonly ScopeTreeNode[], scope: AdminScope, type: ScopeTreeNode["type"], id: string): AdminScope {
  return toggleSelection(nodes, scope, type, id, WRITE_KEYS);
}

function toggleSelection(nodes: readonly ScopeTreeNode[], scope: AdminScope, type: ScopeTreeNode["type"], id: string, keys: typeof VIEW_KEYS | typeof WRITE_KEYS): AdminScope {
  const path = findNodePath(nodes, type, id);
  if (!path) return cloneScope(scope);

  const selection = selectionOf(scope, keys);
  const current = nodeStateInTree(nodes, selection, type, id);
  const groupIds = new Set(selection.groupIds);
  const connectionIds = new Set(selection.connectionIds);
  materializeSelectedAncestors(path, groupIds, connectionIds);

  const target = path[path.length - 1]!;
  if (target.type === "group") {
    clearSubtree(target, groupIds, connectionIds);
    if (current !== "checked") groupIds.add(target.id);
  } else if (current === "checked") {
    connectionIds.delete(target.id);
  } else {
    connectionIds.add(target.id);
  }

  collapseFullySelectedGroups(nodes, groupIds, connectionIds, keys);
  if (keys.group === "query_write_group_ids") {
    return { ...scope, query_write_group_ids: [...groupIds], query_write_connection_ids: [...connectionIds] };
  }
  return { ...scope, allowed_group_ids: [...groupIds], allowed_connection_ids: [...connectionIds] };
}

export function filterScopeTree(nodes: readonly ScopeTreeNode[], query: string): ScopeTreeNode[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return nodes.map(cloneNode);

  const filterNode = (node: ScopeTreeNode): ScopeTreeNode | null => {
    const children = (node.children ?? []).map(filterNode).filter((child): child is ScopeTreeNode => child !== null);
    if (!node.name.toLocaleLowerCase().includes(normalized) && children.length === 0) return null;
    return { ...node, ...(node.type === "group" ? { children } : {}) };
  };
  return nodes.map(filterNode).filter((node): node is ScopeTreeNode => node !== null);
}

export function flattenScopeTree(nodes: readonly ScopeTreeNode[], expandedGroupIds: ReadonlySet<string>, forceExpanded = false, depth = 0): ScopeTreeRow[] {
  const rows: ScopeTreeRow[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.type === "group" && (forceExpanded || expandedGroupIds.has(node.id))) {
      rows.push(...flattenScopeTree(node.children ?? [], expandedGroupIds, forceExpanded, depth + 1));
    }
  }
  return rows;
}

export function collectScopeGroupIds(nodes: readonly ScopeTreeNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    if (node.type !== "group") continue;
    ids.push(node.id, ...collectScopeGroupIds(node.children ?? []));
  }
  return ids;
}

function cloneScope(scope: AdminScope): AdminScope {
  return {
    allowed_group_ids: [...scope.allowed_group_ids],
    allowed_connection_ids: [...scope.allowed_connection_ids],
    query_write_group_ids: [...(scope.query_write_group_ids ?? [])],
    query_write_connection_ids: [...(scope.query_write_connection_ids ?? [])],
  };
}

function cloneNode(node: ScopeTreeNode): ScopeTreeNode {
  return { ...node, ...(node.children ? { children: node.children.map(cloneNode) } : {}) };
}

function findNodePath(nodes: readonly ScopeTreeNode[], type: ScopeTreeNode["type"], id: string, ancestors: ScopeTreeNode[] = []): ScopeTreeNode[] | null {
  for (const node of nodes) {
    const path = [...ancestors, node];
    if (node.type === type && node.id === id) return path;
    const nested = findNodePath(node.children ?? [], type, id, path);
    if (nested) return nested;
  }
  return null;
}

function materializeSelectedAncestors(path: ScopeTreeNode[], groupIds: Set<string>, connectionIds: Set<string>) {
  let coveredByAncestor = false;
  for (let index = 0; index < path.length - 1; index += 1) {
    const ancestor = path[index]!;
    if (ancestor.type !== "group") continue;
    const coversBranch = coveredByAncestor || groupIds.has(ancestor.id);
    if (!coversBranch) continue;
    groupIds.delete(ancestor.id);
    coveredByAncestor = true;
    const branch = path[index + 1];
    for (const child of ancestor.children ?? []) {
      if (child === branch) continue;
      if (child.type === "group") groupIds.add(child.id);
      else connectionIds.add(child.id);
    }
  }
}

function clearSubtree(node: ScopeTreeNode, groupIds: Set<string>, connectionIds: Set<string>) {
  if (node.type === "group") groupIds.delete(node.id);
  else connectionIds.delete(node.id);
  for (const child of node.children ?? []) clearSubtree(child, groupIds, connectionIds);
}

function collapseFullySelectedGroups(nodes: readonly ScopeTreeNode[], groupIds: Set<string>, connectionIds: Set<string>, keys: typeof VIEW_KEYS | typeof WRITE_KEYS) {
  for (const node of nodes) {
    if (node.type !== "group") continue;
    collapseFullySelectedGroups(node.children ?? [], groupIds, connectionIds, keys);
    const children = node.children ?? [];
    if (children.length === 0 || groupIds.has(node.id)) continue;
    const selection: ScopeSelection = { groupIds: [...groupIds], connectionIds: [...connectionIds] };
    if (!children.every((child) => nodeStateIn(selection, child) === "checked")) continue;
    for (const child of children) clearSubtree(child, groupIds, connectionIds);
    groupIds.add(node.id);
  }
}

/** view 语义下实际可见的连接 ID（分组勾选向下覆盖）。 */
function visibleConnectionIds(nodes: readonly ScopeTreeNode[], selection: ScopeSelection): Set<string> {
  const result = new Set<string>();
  const walk = (node: ScopeTreeNode, coveredByAncestor: boolean) => {
    const covered = coveredByAncestor || (node.type === "group" && selection.groupIds.includes(node.id));
    if (node.type === "connection" && (covered || selection.connectionIds.includes(node.id))) result.add(node.id);
    for (const child of node.children ?? []) walk(child, covered);
  };
  for (const node of nodes) walk(node, false);
  return result;
}

function pruneConnectionWritesOutsideVisibility(nodes: readonly ScopeTreeNode[], scope: AdminScope): AdminScope {
  const visible = visibleConnectionIds(nodes, selectionOf(scope, VIEW_KEYS));
  const writes = selectionOf(scope, WRITE_KEYS).connectionIds.filter((id) => visible.has(id));
  return { ...scope, query_write_connection_ids: writes };
}
