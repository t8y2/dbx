import type { AdminScope, ScopeTreeNode } from "@/lib/admin/adminApi";

export type ScopeNodeState = "checked" | "indeterminate" | "unchecked";

export interface ScopeTreeRow {
  node: ScopeTreeNode;
  depth: number;
}

export function scopeNodeState(node: ScopeTreeNode, scope: AdminScope, inherited = false): ScopeNodeState {
  if (inherited) return "checked";
  if (node.type === "connection") return scope.allowed_connection_ids.includes(node.id) ? "checked" : "unchecked";
  if (scope.allowed_group_ids.includes(node.id)) return "checked";

  const children = node.children ?? [];
  if (children.length === 0) return "unchecked";
  const states = children.map((child) => scopeNodeState(child, scope));
  if (states.every((state) => state === "checked")) return "checked";
  if (states.some((state) => state !== "unchecked")) return "indeterminate";
  return "unchecked";
}

export function scopeNodeStateInTree(nodes: readonly ScopeTreeNode[], scope: AdminScope, type: ScopeTreeNode["type"], id: string): ScopeNodeState {
  const path = findNodePath(nodes, type, id);
  if (!path) return "unchecked";
  const inherited = path.slice(0, -1).some((node) => node.type === "group" && scope.allowed_group_ids.includes(node.id));
  return scopeNodeState(path[path.length - 1]!, scope, inherited);
}

export function toggleScopeNode(nodes: readonly ScopeTreeNode[], scope: AdminScope, type: ScopeTreeNode["type"], id: string): AdminScope {
  const path = findNodePath(nodes, type, id);
  if (!path) return cloneScope(scope);

  const current = scopeNodeStateInTree(nodes, scope, type, id);
  const groupIds = new Set(scope.allowed_group_ids);
  const connectionIds = new Set(scope.allowed_connection_ids);
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

  collapseFullySelectedGroups(nodes, groupIds, connectionIds);
  return { allowed_group_ids: [...groupIds], allowed_connection_ids: [...connectionIds] };
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
  return { allowed_group_ids: [...scope.allowed_group_ids], allowed_connection_ids: [...scope.allowed_connection_ids] };
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

function collapseFullySelectedGroups(nodes: readonly ScopeTreeNode[], groupIds: Set<string>, connectionIds: Set<string>) {
  for (const node of nodes) {
    if (node.type !== "group") continue;
    collapseFullySelectedGroups(node.children ?? [], groupIds, connectionIds);
    const children = node.children ?? [];
    if (children.length === 0 || groupIds.has(node.id)) continue;
    const scope = { allowed_group_ids: [...groupIds], allowed_connection_ids: [...connectionIds] };
    if (!children.every((child) => scopeNodeState(child, scope) === "checked")) continue;
    for (const child of children) clearSubtree(child, groupIds, connectionIds);
    groupIds.add(node.id);
  }
}
