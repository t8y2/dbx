import type { ConnectionGroup, TableVGroupLayout, TableVGroupOrderEntry, TreeNode } from "@/types/database";
import { uuid } from "@/lib/common/utils";

export type { TableVGroupLayout, TableVGroupOrderEntry };

/**
 * Table virtual groups (issue #3470): a purely local, per-scope arrangement of
 * table names into nested folders, mirroring the connection sidebar layout
 * model (`SidebarLayout`) but keyed by table name instead of connection id.
 * Layouts never touch database metadata — unknown table names are tolerated so
 * groups can reference tables outside the currently loaded sidebar page.
 */

export type TableVGroupDropPosition = "before" | "after" | "inside";

export interface TableVGroupScope {
  connectionId?: string;
  catalog?: string;
  database?: string;
  schema?: string;
  linkedServer?: string;
}

type TableVGroupEntry = Extract<TableVGroupOrderEntry, { type: "group" }>;

export function emptyTableVGroupLayout(): TableVGroupLayout {
  return { groups: [], order: [] };
}

export function hasTableVGroupEntries(layout: TableVGroupLayout | null | undefined): layout is TableVGroupLayout {
  return !!layout && (layout.groups.length > 0 || layout.order.length > 0);
}

/** Vgroups stay visible unless the user explicitly hid them. */
export function tableVGroupsEnabled(layout: TableVGroupLayout | null | undefined): boolean {
  return hasTableVGroupEntries(layout) && layout.enabled !== false;
}

export function tableVGroupScopeKey(scope: TableVGroupScope): string | null {
  if (!scope.connectionId || !scope.database) return null;
  return [scope.connectionId, scope.linkedServer ?? "", scope.catalog ?? "", scope.database, scope.schema ?? ""].join("\u0000");
}

const TABLE_VGROUP_NODE_ID_PREFIX = "table-vgroup:";

export function tableVGroupNodeId(groupId: string): string {
  return `${TABLE_VGROUP_NODE_ID_PREFIX}${groupId}`;
}

export function tableVGroupIdFromNodeId(nodeId: string): string | null {
  return nodeId.startsWith(TABLE_VGROUP_NODE_ID_PREFIX) ? nodeId.slice(TABLE_VGROUP_NODE_ID_PREFIX.length) : null;
}

/** Tree node types whose direct children may contain table nodes to group. */
const TABLE_VGROUP_CONTAINER_TYPES: ReadonlySet<TreeNode["type"]> = new Set(["database", "schema", "linked-server-schema", "group-tables"]);

/**
 * Selection semantics for "move to group", mirroring the connection tree: when
 * several rows are selected and the right-clicked table is part of that
 * selection, the whole selection moves; anything outside the right-clicked
 * table's connection+database scope is ignored. Otherwise only the clicked row.
 */
export function selectedTableVGroupMoveTargets(currentNode: TreeNode, selectedNodes: readonly TreeNode[]): TreeNode[] {
  if (currentNode.type !== "table" || !currentNode.connectionId) return currentNode.type === "table" ? [currentNode] : [];
  const inScope = (node: TreeNode) => node.type === "table" && node.connectionId === currentNode.connectionId && (node.database ?? "") === (currentNode.database ?? "") && (node.schema ?? "") === (currentNode.schema ?? "");
  const selectedContainsCurrent = selectedNodes.some((node) => node.id === currentNode.id);
  if (selectedNodes.length > 1 && selectedContainsCurrent && selectedNodes.every(inScope)) return [...selectedNodes];
  return [currentNode];
}

function entryChildren(entry: TableVGroupEntry): TableVGroupOrderEntry[] {
  return entry.children ?? [];
}

function cloneEntries(entries: TableVGroupOrderEntry[]): TableVGroupOrderEntry[] {
  return entries.map((entry) => (entry.type === "group" ? { type: "group", id: entry.id, children: cloneEntries(entryChildren(entry)) } : { ...entry }));
}

function findGroupEntry(entries: TableVGroupOrderEntry[], groupId: string): TableVGroupEntry | null {
  for (const entry of entries) {
    if (entry.type !== "group") continue;
    if (entry.id === groupId) return entry;
    const found = findGroupEntry(entryChildren(entry), groupId);
    if (found) return found;
  }
  return null;
}

function containsGroup(entry: TableVGroupOrderEntry, groupId: string): boolean {
  if (entry.type !== "group") return false;
  if (entry.id === groupId) return true;
  return entryChildren(entry).some((child) => containsGroup(child, groupId));
}

function removeTableFromEntries(entries: TableVGroupOrderEntry[], tableName: string): TableVGroupOrderEntry[] {
  return entries.filter((entry) => !(entry.type === "table" && entry.name === tableName)).map((entry) => (entry.type === "group" ? { type: "group" as const, id: entry.id, children: removeTableFromEntries(entryChildren(entry), tableName) } : entry));
}

function expandGroup(layout: TableVGroupLayout, groupId: string): TableVGroupLayout {
  return {
    ...layout,
    groups: layout.groups.map((group) => (group.id === groupId ? { ...group, collapsed: false } : group)),
  };
}

export function moveTableToVGroup(layout: TableVGroupLayout, tableName: string, targetGroupId: string | null): TableVGroupLayout {
  if (!hasTableVGroupEntries(layout)) return layout;
  const order = removeTableFromEntries(cloneEntries(layout.order), tableName);
  const entry: TableVGroupOrderEntry = { type: "table", name: tableName };

  if (targetGroupId) {
    const group = findGroupEntry(order, targetGroupId);
    if (group) {
      group.children = [...(group.children ?? []), entry];
      return { ...expandGroup(layout, targetGroupId), order };
    }
  }

  order.push(entry);
  return { ...layout, order };
}

export function reorderTableVGroupEntry(layout: TableVGroupLayout, draggedEntryId: string, targetEntryId: string, position: TableVGroupDropPosition): TableVGroupLayout {
  if (!hasTableVGroupEntries(layout) || draggedEntryId === targetEntryId) return layout;

  const entryId = (entry: TableVGroupOrderEntry): string => (entry.type === "group" ? entry.id : entry.name);
  const removeEntry = (entries: TableVGroupOrderEntry[]): TableVGroupOrderEntry | null => {
    for (let i = 0; i < entries.length; i++) {
      if (entryId(entries[i]!) === draggedEntryId) return entries.splice(i, 1)[0]!;
      const entry = entries[i]!;
      if (entry.type === "group") {
        const removed = removeEntry(entryChildren(entry));
        if (removed) return removed;
      }
    }
    return null;
  };

  const order = cloneEntries(layout.order);
  const dragged = removeEntry(order);
  if (!dragged) return layout;

  if (dragged.type === "group" && containsGroup(dragged, targetEntryId)) return layout;

  if (position === "inside") {
    const targetGroup = findGroupEntry(order, targetEntryId);
    if (targetGroup) {
      targetGroup.children = [...(targetGroup.children ?? []), dragged];
      return { ...layout, order };
    }
  }

  const insertNear = (entries: TableVGroupOrderEntry[]): boolean => {
    for (let i = 0; i < entries.length; i++) {
      if (entryId(entries[i]!) === targetEntryId) {
        entries.splice(position === "after" ? i + 1 : i, 0, dragged);
        return true;
      }
      const entry = entries[i]!;
      if (entry.type === "group" && insertNear(entryChildren(entry))) return true;
    }
    return false;
  };

  if (!insertNear(order)) order.push(dragged);
  return { ...layout, order };
}

export function createTableVGroup(layout: TableVGroupLayout, name: string, parentGroupId?: string | null): { layout: TableVGroupLayout; groupId: string } {
  const groupId = uuid();
  const group: ConnectionGroup = { id: groupId, name, collapsed: false };
  const order = cloneEntries(layout.order);
  const entry: TableVGroupOrderEntry = { type: "group", id: groupId, children: [] };

  let parentFound = false;
  if (parentGroupId) {
    const parent = findGroupEntry(order, parentGroupId);
    if (parent) {
      parent.children = [...(parent.children ?? []), entry];
      parentFound = true;
    } else {
      order.push(entry);
    }
  } else {
    order.push(entry);
  }

  return {
    groupId,
    layout: {
      enabled: layout.enabled,
      groups: [...layout.groups, group].map((current) => (parentFound && current.id === parentGroupId ? { ...current, collapsed: false } : current)),
      order,
    },
  };
}

export function renameTableVGroup(layout: TableVGroupLayout, groupId: string, name: string): TableVGroupLayout {
  return {
    ...layout,
    groups: layout.groups.map((group) => (group.id === groupId ? { ...group, name } : group)),
  };
}

/** Deleting groups keeps their tables: members flatten back into the parent level. */
export function deleteTableVGroups(layout: TableVGroupLayout, groupIds: Iterable<string>): TableVGroupLayout {
  if (!hasTableVGroupEntries(layout)) return layout;
  const targets = new Set(groupIds);
  if (!targets.size) return layout;

  const removedGroupIds = new Set<string>();
  const flattenDeletedGroup = (entry: TableVGroupEntry): TableVGroupOrderEntry[] => {
    removedGroupIds.add(entry.id);
    return entryChildren(entry).flatMap((child): TableVGroupOrderEntry[] => {
      if (child.type === "table") return [{ ...child }];
      return flattenDeletedGroup(child);
    });
  };
  const removeGroups = (entries: TableVGroupOrderEntry[]): TableVGroupOrderEntry[] =>
    entries.flatMap((entry): TableVGroupOrderEntry[] => {
      if (entry.type === "table") return [{ ...entry }];
      if (targets.has(entry.id)) return flattenDeletedGroup(entry);
      const children = removeGroups(entryChildren(entry));
      return [{ type: "group", id: entry.id, children }];
    });

  const order = removeGroups(layout.order);
  if (!removedGroupIds.size) return layout;
  return { enabled: layout.enabled, groups: layout.groups.filter((group) => !removedGroupIds.has(group.id)), order };
}

export function toggleTableVGroupCollapsed(layout: TableVGroupLayout, groupId: string): TableVGroupLayout {
  return {
    ...layout,
    groups: layout.groups.map((group) => (group.id === groupId ? { ...group, collapsed: !group.collapsed } : group)),
  };
}

export function setTableVGroupsEnabled(layout: TableVGroupLayout, enabled: boolean): TableVGroupLayout {
  return { ...layout, enabled };
}

export interface TableVGroupDestinationRow {
  id: string;
  name: string;
  path: string[];
}

/** Build selectable vgroup destinations in the same tree order as the sidebar. */
export function tableVGroupDestinationRows(layout: TableVGroupLayout | null | undefined): TableVGroupDestinationRow[] {
  if (!hasTableVGroupEntries(layout)) return [];
  const rows: TableVGroupDestinationRow[] = [];
  const walk = (entries: TableVGroupOrderEntry[], path: string[]) => {
    for (const entry of entries) {
      if (entry.type !== "group") continue;
      const name = layout.groups.find((group) => group.id === entry.id)?.name ?? entry.id;
      const nextPath = [...path, name];
      rows.push({ id: entry.id, name, path: nextPath });
      walk(entryChildren(entry), nextPath);
    }
  };
  walk(layout.order, []);
  return rows;
}

/** Stable root-to-leaf group-id path containing the table, empty when ungrouped. */
export function tableVGroupPathForTable(layout: TableVGroupLayout | null | undefined, tableName: string): string[] {
  if (!hasTableVGroupEntries(layout)) return [];
  const walk = (entries: TableVGroupOrderEntry[], path: string[]): string[] | null => {
    for (const entry of entries) {
      if (entry.type === "table" && entry.name === tableName) return path;
      if (entry.type !== "group") continue;
      const found = walk(entryChildren(entry), [...path, entry.id]);
      if (found) return found;
    }
    return null;
  };
  return walk(layout.order, []) ?? [];
}

// ---------------------------------------------------------------------------
// Display projection
// ---------------------------------------------------------------------------

interface TableVGroupFlatTable {
  node: TreeNode;
  flatIndex: number;
}

function buildVGroupChildNodes(entries: TableVGroupOrderEntry[], layout: TableVGroupLayout, tables: Map<string, TableVGroupFlatTable>, scope: TableVGroupScope): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const entry of entries) {
    if (entry.type === "table") {
      const table = tables.get(entry.name);
      if (table) nodes.push(table.node);
      continue;
    }
    const group = layout.groups.find((candidate) => candidate.id === entry.id);
    if (!group) continue;
    nodes.push({
      id: tableVGroupNodeId(entry.id),
      label: group.name,
      type: "table-vgroup",
      connectionId: scope.connectionId,
      catalog: scope.catalog,
      database: scope.database,
      schema: scope.schema,
      linkedServer: scope.linkedServer,
      vgroupId: entry.id,
      isExpanded: !group.collapsed,
      children: buildVGroupChildNodes(entryChildren(entry), layout, tables, scope),
    });
  }
  return nodes;
}

/**
 * Build the root-level projected nodes. Virtual groups always float to the top
 * of the container in layout order (matching Navicat's table groups), followed
 * by ungrouped tables and non-table rows at their original flat positions.
 */
function buildVGroupRootNodes(entries: TableVGroupOrderEntry[], layout: TableVGroupLayout, tables: Map<string, TableVGroupFlatTable>, scope: TableVGroupScope): Array<{ node: TreeNode; sortIndex: number }> {
  const out: Array<{ node: TreeNode; sortIndex: number }> = [];
  let groupSeq = 0;
  for (const entry of entries) {
    if (entry.type === "table") {
      const table = tables.get(entry.name);
      if (table) out.push({ node: table.node, sortIndex: table.flatIndex });
      continue;
    }
    const group = layout.groups.find((candidate) => candidate.id === entry.id);
    if (!group) continue;
    out.push({
      node: {
        id: tableVGroupNodeId(entry.id),
        label: group.name,
        type: "table-vgroup",
        connectionId: scope.connectionId,
        catalog: scope.catalog,
        database: scope.database,
        schema: scope.schema,
        linkedServer: scope.linkedServer,
        vgroupId: entry.id,
        isExpanded: !group.collapsed,
        children: buildVGroupChildNodes(entryChildren(entry), layout, tables, scope),
      },
      // -1e6 keeps every group above flat rows while preserving layout order among groups.
      sortIndex: -1_000_000 + groupSeq++,
    });
  }
  return out;
}

/**
 * Rearrange loaded table nodes under their virtual groups. Pure display-level
 * transform over an already-loaded child list: table node objects are
 * re-parented by reference so per-node state (isExpanded / isLoading / loaded
 * children) survives projection. Members missing from the loaded page simply
 * stay absent (sidebar pagination); stale names are skipped.
 */
export function applyTableVGroupsToChildren(children: TreeNode[], layout: TableVGroupLayout | null | undefined, scope: TableVGroupScope): TreeNode[] {
  if (!children.length || !layout || !tableVGroupsEnabled(layout)) return children;
  const activeLayout = layout;

  const tables = new Map<string, TableVGroupFlatTable>();
  const passthrough: Array<{ node: TreeNode; sortIndex: number }> = [];
  for (let i = 0; i < children.length; i++) {
    const node = children[i]!;
    if (node.type === "table" && !tables.has(node.label)) tables.set(node.label, { node, flatIndex: i });
    else passthrough.push({ node, sortIndex: i });
  }
  if (!tables.size) return children;

  const rootBuilt = buildVGroupRootNodes(activeLayout.order, activeLayout, tables, scope);
  // Tables the layout does not reference stay ungrouped at their original slot.
  const consumed = new Set<TreeNode>();
  const consume = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.type === "table") consumed.add(node);
      else consume(node.children ?? []);
    }
  };
  consume(rootBuilt.map((item) => item.node));
  for (const table of tables.values()) {
    if (!consumed.has(table.node)) passthrough.push({ node: table.node, sortIndex: table.flatIndex });
  }

  const merged = [...rootBuilt, ...passthrough];
  merged.sort((a, b) => a.sortIndex - b.sortIndex);
  return merged.map((item) => item.node);
}

/**
 * Inverse of the projection: flatten vgroup containers back into a plain
 * table list so a scope can be re-projected from a mutated layout without a
 * metadata reload. Table node objects keep their identity.
 */
export function stripTableVGroupsFromChildren(children: TreeNode[]): TreeNode[] {
  if (!children.some((node) => node.type === "table-vgroup")) return children;
  const result: TreeNode[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.type === "table-vgroup") {
        walk(node.children ?? []);
        continue;
      }
      result.push(node);
    }
  };
  walk(children);
  return result;
}

/**
 * Find the live tree node whose children this scope's layout projects. Table
 * rows and their container do not always carry identical optional identity
 * fields (a simple-display database node has no schema while its table rows
 * do), so optional parts tolerate a missing value on either side; when several
 * containers match, the one that actually holds table rows wins.
 */
export function findTableVGroupContainerNode(nodes: TreeNode[], scope: TableVGroupScope, tableName?: string): TreeNode | null {
  const matchesOptional = (nodeValue: string | undefined, scopeValue: string | undefined) => nodeValue === scopeValue || !nodeValue || !scopeValue;
  const candidates: TreeNode[] = [];
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      if (
        TABLE_VGROUP_CONTAINER_TYPES.has(node.type) &&
        node.connectionId === scope.connectionId &&
        (node.database ?? "") === (scope.database ?? "") &&
        matchesOptional(node.catalog, scope.catalog) &&
        matchesOptional(node.schema, scope.schema) &&
        matchesOptional(node.linkedServer, scope.linkedServer)
      ) {
        candidates.push(node);
      }
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  if (!candidates.length) return null;

  if (tableName) {
    const holder = candidates.find((node) => (node.children ?? []).some((child) => child.type === "table" && child.label === tableName));
    if (holder) return holder;
  }
  return candidates.find((node) => (node.children ?? []).some((child) => child.type === "table" || child.type === "table-vgroup")) ?? candidates[0]!;
}
