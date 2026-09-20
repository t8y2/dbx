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
  return { version: TABLE_VGROUP_LAYOUT_VERSION, groups: [], order: [] };
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

const TABLE_VGROUP_LAYOUT_VERSION = 1;

export function tableVGroupNodeId(groupId: string): string {
  return `${TABLE_VGROUP_NODE_ID_PREFIX}${groupId}`;
}

export function tableVGroupIdFromNodeId(nodeId: string): string | null {
  return nodeId.startsWith(TABLE_VGROUP_NODE_ID_PREFIX) ? nodeId.slice(TABLE_VGROUP_NODE_ID_PREFIX.length) : null;
}

/** Tree node types whose direct children may contain table nodes to group. */
const TABLE_VGROUP_CONTAINER_TYPES: ReadonlySet<TreeNode["type"]> = new Set(["database", "schema", "linked-server-schema", "group-tables"]);

/** 行的身份字段即 scope 字段；分组节点与各类容器直接自带这五项。 */
function tableVGroupScopeFieldsOf(node: TreeNode): TableVGroupScope {
  return { connectionId: node.connectionId, catalog: node.catalog, database: node.database, schema: node.schema, linkedServer: node.linkedServer };
}

/** 承载表行的容器行：分组投影的挂载点，也是拖拽「移出分组」的落点。 */
export function isTableVGroupContainerNode(node: TreeNode): boolean {
  return TABLE_VGROUP_CONTAINER_TYPES.has(node.type);
}

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
      version: layout.version,
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
  return { enabled: layout.enabled, version: layout.version, groups: layout.groups.filter((group) => !removedGroupIds.has(group.id)), order };
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
  // Idempotence: merge/refresh flows re-feed already-projected children back
  // into setChildren, so always strip existing group containers first —
  // otherwise stale group copies survive alongside the freshly built ones.
  const activeLayout = layout;
  const flatChildren = stripTableVGroupsFromChildren(children);

  const tables = new Map<string, TableVGroupFlatTable>();
  const passthrough: Array<{ node: TreeNode; sortIndex: number }> = [];
  for (let i = 0; i < flatChildren.length; i++) {
    const node = flatChildren[i]!;
    if (node.type === "table" && !tables.has(node.label)) tables.set(node.label, { node, flatIndex: i });
    else passthrough.push({ node, sortIndex: i });
  }
  if (!tables.size) return flatChildren;

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
      if (isTableVGroupContainerNode(node) && node.connectionId === scope.connectionId && (node.database ?? "") === (scope.database ?? "") && matchesOptional(node.catalog, scope.catalog) && matchesOptional(node.schema, scope.schema) && matchesOptional(node.linkedServer, scope.linkedServer)) {
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

/**
 * Validate and repair a layout loaded from persistence: malformed JSON
 * structures, unknown group references, and duplicate ids are dropped instead
 * of poisoning the sidebar. Normalized layouts carry the current version.
 */
export function normalizeTableVGroupLayout(value: unknown): TableVGroupLayout {
  const layout = emptyTableVGroupLayout();
  if (!value || typeof value !== "object") return layout;
  const raw = value as Partial<TableVGroupLayout>;
  if (!Array.isArray(raw.groups) || !Array.isArray(raw.order)) return layout;

  const seenGroupIds = new Set<string>();
  const groups: ConnectionGroup[] = [];
  for (const group of raw.groups) {
    if (!group || typeof group !== "object") continue;
    const candidate = group as Partial<ConnectionGroup>;
    if (typeof candidate.id !== "string" || !candidate.id || typeof candidate.name !== "string" || !candidate.name) continue;
    if (seenGroupIds.has(candidate.id)) continue;
    seenGroupIds.add(candidate.id);
    groups.push({ id: candidate.id, name: candidate.name, collapsed: candidate.collapsed === true });
  }

  const validGroupIds = new Set(groups.map((group) => group.id));
  const normalizeEntries = (entries: unknown): TableVGroupOrderEntry[] => {
    const out: TableVGroupOrderEntry[] = [];
    if (!Array.isArray(entries)) return out;
    // 同一层里重复的表名或分组引用会投影出重复节点（渲染以 id 作 key），
    // 损坏的持久化数据必须在归一化这一步收敛。
    const seenTableNames = new Set<string>();
    const seenGroupEntries = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as Partial<TableVGroupOrderEntry>;
      if (candidate.type === "table") {
        if (typeof candidate.name !== "string" || !candidate.name || seenTableNames.has(candidate.name)) continue;
        seenTableNames.add(candidate.name);
        out.push({ type: "table", name: candidate.name });
      } else if (candidate.type === "group" && typeof candidate.id === "string" && candidate.id && validGroupIds.has(candidate.id) && !seenGroupEntries.has(candidate.id)) {
        seenGroupEntries.add(candidate.id);
        out.push({ type: "group", id: candidate.id, children: normalizeEntries(entryChildren(candidate as TableVGroupEntry)) });
      }
    }
    return out;
  };
  const order = normalizeEntries(raw.order);

  return {
    version: TABLE_VGROUP_LAYOUT_VERSION,
    groups,
    order,
    enabled: raw.enabled !== false,
  };
}

function isTableVGroupDisplayNode(type: TreeNode["type"] | undefined): boolean {
  return type === "table-vgroup" || (typeof type === "string" && type.startsWith("group-"));
}

/**
 * 对象分组节点（group-tables / group-views…）与投影出的分组行都是宿主容器下的
 * 显示层节点，其 database/schema 字段按查询语义填充（sqlite 把 main 同时填进
 * schema），直接取用会让不同显示模式与不同入口解析出不同 scope_key、把同一批表
 * 的分组劈成两份。因此分组身份一律上溯到 database/schema 一类宿主容器。
 */
function findTableVGroupHostContainer(nodes: TreeNode[], node: TreeNode): TreeNode | null {
  const walk = (list: TreeNode[], ancestors: TreeNode[]): TreeNode | null => {
    for (const item of list) {
      if (item === node || item.id === node.id) {
        for (let i = ancestors.length - 1; i >= 0; i--) {
          const ancestor = ancestors[i]!;
          if (isTableVGroupContainerNode(ancestor) && !isTableVGroupDisplayNode(ancestor.type)) return ancestor;
        }
        return null;
      }
      if (item.children) {
        const found = walk(item.children, [...ancestors, item]);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(nodes, []);
}

function tableVGroupScopeHostOf(nodes: TreeNode[], node: TreeNode): TreeNode {
  return isTableVGroupDisplayNode(node.type) ? (findTableVGroupHostContainer(nodes, node) ?? node) : node;
}

/**
 * Derive the layout scope for any sidebar row: containers and group nodes own
 * their fields directly, while table rows resolve to their holding container —
 * in simple display mode a table row carries a schema its container lacks, so
 * using the row's own fields would split reads and writes across two keys.
 */
export function resolveTableVGroupScopeFromNode(nodes: TreeNode[], node: TreeNode | TableVGroupScope): TableVGroupScope {
  const row = node as Partial<TreeNode> & TableVGroupScope;
  if (row.type === "table-vgroup" || row.type?.startsWith("group-")) return tableVGroupScopeFieldsOf(tableVGroupScopeHostOf(nodes, row as TreeNode));
  if (isTableVGroupContainerNode(row as TreeNode)) return tableVGroupScopeFieldsOf(row as TreeNode);
  const container = findTableVGroupContainerNode(nodes, row as TreeNode, row.type === "table" ? row.label : undefined);
  return tableVGroupScopeFieldsOf(container ? tableVGroupScopeHostOf(nodes, container) : (row as TreeNode));
}

/**
 * 任意深度出现分页游标都说明列表不完整：TDengine 等把末页游标嵌在 STABLE 的子表
 * 分区节点下，只看顶层会把部分页当成全量，进而误删分组成员。
 */
export function hasTableTreeLoadMore(nodes: readonly TreeNode[]): boolean {
  return nodes.some((node) => node.type === "load-more" || (node.children ? hasTableTreeLoadMore(node.children) : false));
}

/** 收集子树里的表行名；多收只会让回收更保守，不会误删成员。 */
export function collectTableTreeNames(nodes: readonly TreeNode[]): Set<string> {
  const names = new Set<string>();
  const walk = (list: readonly TreeNode[]) => {
    for (const node of list) {
      if (node.type === "table" && node.label) names.add(node.label);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return names;
}

/**
 * Drop layout members whose names are absent from a complete, unfiltered table
 * load (renamed or deleted tables). Callers must only pass complete lists —
 * paginated or filtered pages cannot decide membership. Groups themselves are
 * kept even when they end up empty: they are user-created structure, so an
 * empty group stays visible instead of vanishing with its last table.
 */
export function pruneTableVGroupMembers(layout: TableVGroupLayout, keepNames: ReadonlySet<string>): TableVGroupLayout {
  if (!hasTableVGroupEntries(layout)) return layout;
  let changed = false;
  const prune = (entries: TableVGroupOrderEntry[]): TableVGroupOrderEntry[] => {
    const out: TableVGroupOrderEntry[] = [];
    for (const entry of entries) {
      if (entry.type === "table") {
        if (keepNames.has(entry.name)) out.push(entry);
        else changed = true;
        continue;
      }
      const children = prune(entryChildren(entry));
      if (children.length !== entryChildren(entry).length) changed = true;
      out.push({ type: "group", id: entry.id, children });
    }
    return out;
  };
  const order = prune(cloneEntries(layout.order));
  return changed ? { enabled: layout.enabled, version: layout.version, groups: layout.groups, order } : layout;
}
