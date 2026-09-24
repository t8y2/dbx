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

/**
 * 分组作用域覆盖的对象容器类别。tables 是 #3470 起的既有行为；views /
 * procedures / triggers 对应 #9446 方向一与 #9733；其余容器类别为同一机制的
 * 全量补齐（与 groupDefs 的库级对象容器一一对应）。
 */
export type TableVGroupObjectKind = "tables" | "views" | "materialized_views" | "procedures" | "functions" | "triggers" | "sequences" | "events" | "synonyms" | "jobs" | "packages" | "types";

export interface TableVGroupScope {
  connectionId?: string;
  catalog?: string;
  database?: string;
  schema?: string;
  linkedServer?: string;
  /** 本布局归属的容器类别；缺省视为 tables（历史 scope 均为表分组）。 */
  objectType?: TableVGroupObjectKind;
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
  const parts = [scope.connectionId, scope.linkedServer ?? "", scope.catalog ?? "", scope.database, scope.schema ?? ""];
  // 仅非表容器在尾部追加类别段：表分组的 key 与历史持久化逐字节一致，零迁移。
  if (scope.objectType && scope.objectType !== "tables") parts.push(scope.objectType);
  return parts.join("\u0000");
}

const TABLE_VGROUP_NODE_ID_PREFIX = "table-vgroup:";

const TABLE_VGROUP_LAYOUT_VERSION = 1;

export function tableVGroupNodeId(groupId: string): string {
  return `${TABLE_VGROUP_NODE_ID_PREFIX}${groupId}`;
}

export function tableVGroupIdFromNodeId(nodeId: string): string | null {
  return nodeId.startsWith(TABLE_VGROUP_NODE_ID_PREFIX) ? nodeId.slice(TABLE_VGROUP_NODE_ID_PREFIX.length) : null;
}

/**
 * 承载可分组行的容器行 → 分组类别。group-triggers 双栖：库级触发器列表与
 * 表结构子组共用同一 type，表子级带 tableName，不算库级分组容器。
 */
export function tableVGroupKindOfContainerNode(node: Pick<TreeNode, "type" | "tableName">): TableVGroupObjectKind | null {
  switch (node.type) {
    case "database":
    case "schema":
    case "linked-server-schema":
    case "group-tables":
      return "tables";
    case "group-views":
      return "views";
    case "group-materialized-views":
      return "materialized_views";
    case "group-procedures":
      return "procedures";
    case "group-functions":
      return "functions";
    case "group-triggers":
      // 双栖 type：库级触发器列表与表结构子组共用；表子级带 tableName。
      return node.tableName ? null : "triggers";
    case "group-sequences":
      return "sequences";
    case "group-events":
      return "events";
    case "group-synonyms":
      return "synonyms";
    case "group-jobs":
      return "jobs";
    case "group-packages":
      return "packages";
    case "group-types":
      return "types";
    default:
      return null;
  }
}

/** 各类别容器里可被分组的行 type；成员身份仍是容器内的行 label。 */
const TABLE_VGROUP_KIND_ROW_TYPES: Record<TableVGroupObjectKind, Record<string, true>> = {
  tables: { table: true },
  views: { view: true },
  materialized_views: { materialized_view: true },
  procedures: { procedure: true },
  functions: { function: true },
  triggers: { trigger: true },
  sequences: { sequence: true },
  events: { event: true },
  synonyms: { synonym: true },
  jobs: { job: true },
  // packages/types 的 spec 与 body 行同名（label 键控成员身份），入组必然合并为
  // 单一成员条目——已知限制：同名双行无法分别归属不同分组。
  packages: { package: true, "package-body": true },
  types: { type: true, "type-body": true },
};

/** 该行 type 是否可被分入某类容器（拖拽源、移动菜单等入口的快速过滤）。 */
export function isTableVGroupGroupableRowType(type: TreeNode["type"]): boolean {
  switch (type) {
    case "table":
    case "view":
    case "materialized_view":
    case "procedure":
    case "function":
    case "trigger":
    case "sequence":
    case "event":
    case "synonym":
    case "job":
    case "package":
    case "package-body":
    case "type":
    case "type-body":
      return true;
    default:
      return false;
  }
}

/** 行的身份字段即 scope 字段；分组节点与各类容器直接自带这五项。 */
function tableVGroupScopeFieldsOf(node: TreeNode): TableVGroupScope {
  return { connectionId: node.connectionId, catalog: node.catalog, database: node.database, schema: node.schema, linkedServer: node.linkedServer };
}

/** 分组投影的挂载点，也是拖拽「移出分组」的落点。 */
export function isTableVGroupContainerNode(node: TreeNode): boolean {
  return tableVGroupKindOfContainerNode(node) !== null;
}

/**
 * Selection semantics for "move to group", mirroring the connection tree: when
 * several rows are selected and the right-clicked row is part of that
 * selection, the whole selection moves; anything outside the right-clicked
 * row's connection+database+type scope is ignored. Otherwise only the clicked
 * row.
 */
export function selectedTableVGroupMoveTargets(currentNode: TreeNode, selectedNodes: readonly TreeNode[]): TreeNode[] {
  if (!isTableVGroupGroupableRowType(currentNode.type) || !currentNode.connectionId) return isTableVGroupGroupableRowType(currentNode.type) ? [currentNode] : [];
  const inScope = (node: TreeNode) => node.type === currentNode.type && node.connectionId === currentNode.connectionId && (node.database ?? "") === (currentNode.database ?? "") && (node.schema ?? "") === (currentNode.schema ?? "");
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

/** 成员条目与 (名字, 行类型) 的匹配：rowType 给定时旧的无类型条目（历史数据）也视为命中。 */
function matchesTableEntry(entry: TableVGroupOrderEntry, name: string, rowType?: string): boolean {
  return entry.type === "table" && entry.name === name && (!rowType || !entry.rowType || entry.rowType === rowType);
}

function removeTableFromEntries(entries: TableVGroupOrderEntry[], tableName: string, rowType?: string): TableVGroupOrderEntry[] {
  return entries.filter((entry) => !matchesTableEntry(entry, tableName, rowType)).map((entry) => (entry.type === "group" ? { type: "group" as const, id: entry.id, children: removeTableFromEntries(entryChildren(entry), tableName, rowType) } : entry));
}

function expandGroup(layout: TableVGroupLayout, groupId: string): TableVGroupLayout {
  return {
    ...layout,
    groups: layout.groups.map((group) => (group.id === groupId ? { ...group, collapsed: false } : group)),
  };
}

export function moveTableToVGroup(layout: TableVGroupLayout, tableName: string, targetGroupId: string | null, rowType?: string): TableVGroupLayout {
  if (!hasTableVGroupEntries(layout)) return layout;
  const order = removeTableFromEntries(cloneEntries(layout.order), tableName, rowType);
  const entry: TableVGroupOrderEntry = { type: "table", name: tableName, ...(rowType ? { rowType } : {}) };

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
export function tableVGroupPathForTable(layout: TableVGroupLayout | null | undefined, tableName: string, rowType?: string): string[] {
  if (!hasTableVGroupEntries(layout)) return [];
  const walk = (entries: TableVGroupOrderEntry[], path: string[]): string[] | null => {
    for (const entry of entries) {
      if (matchesTableEntry(entry, tableName, rowType)) return path;
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

interface TableVGroupFlatRow {
  node: TreeNode;
  flatIndex: number;
}

/** 双索引成员行查找：rowType 精确键 O(1)；无 rowType（历史条目与表）走同名首行索引 O(1)。 */
interface TableVGroupRowLookup {
  byKey: Map<string, TableVGroupFlatRow>;
  byLabel: Map<string, TableVGroupFlatRow>;
}

function findRowIn(lookup: TableVGroupRowLookup, name: string, rowType?: string): TableVGroupFlatRow | undefined {
  if (rowType) return lookup.byKey.get(`${rowType}\u0000${name}`);
  return lookup.byLabel.get(name);
}

const tableRowKey = (type: string, label: string): string => `${type}\u0000${label}`;

function buildVGroupChildNodes(entries: TableVGroupOrderEntry[], layout: TableVGroupLayout, lookup: TableVGroupRowLookup, scope: TableVGroupScope): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const entry of entries) {
    if (entry.type === "table") {
      const row = findRowIn(lookup, entry.name, entry.rowType);
      if (row) nodes.push(row.node);
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
      vgroupKind: scope.objectType ?? "tables",
      isExpanded: !group.collapsed,
      children: buildVGroupChildNodes(entryChildren(entry), layout, lookup, scope),
    });
  }
  return nodes;
}

/**
 * Build the root-level projected nodes. Virtual groups always float to the top
 * of the container in layout order (matching Navicat's table groups), followed
 * by ungrouped rows and non-member rows at their original flat positions.
 */
function buildVGroupRootNodes(entries: TableVGroupOrderEntry[], layout: TableVGroupLayout, lookup: TableVGroupRowLookup, scope: TableVGroupScope): Array<{ node: TreeNode; sortIndex: number }> {
  const out: Array<{ node: TreeNode; sortIndex: number }> = [];
  let groupSeq = 0;
  for (const entry of entries) {
    if (entry.type === "table") {
      const row = findRowIn(lookup, entry.name, entry.rowType);
      if (row) out.push({ node: row.node, sortIndex: row.flatIndex });
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
        vgroupKind: scope.objectType ?? "tables",
        isExpanded: !group.collapsed,
        children: buildVGroupChildNodes(entryChildren(entry), layout, lookup, scope),
      },
      // -1e6 keeps every group above flat rows while preserving layout order among groups.
      sortIndex: -1_000_000 + groupSeq++,
    });
  }
  return out;
}

/**
 * Rearrange loaded container rows under their virtual groups. Pure
 * display-level transform over an already-loaded child list: row node objects
 * are re-parented by reference so per-node state (isExpanded / isLoading /
 * loaded children) survives projection. Members missing from the loaded page
 * simply stay absent (sidebar pagination); stale names are skipped.
 */
export function applyTableVGroupsToChildren(children: TreeNode[], layout: TableVGroupLayout | null | undefined, scope: TableVGroupScope): TreeNode[] {
  if (!children.length || !layout || !tableVGroupsEnabled(layout)) return children;
  // Idempotence: merge/refresh flows re-feed already-projected children back
  // into setChildren, so always strip existing group containers first —
  // otherwise stale group copies survive alongside the freshly built ones.
  const activeLayout = layout;
  const flatChildren = stripTableVGroupsFromChildren(children);

  // scope.objectType 决定哪些行参与分组；缺省 tables 维持既有表分组行为。
  const rowTypes = TABLE_VGROUP_KIND_ROW_TYPES[scope.objectType ?? "tables"];
  const rows: TableVGroupRowLookup = { byKey: new Map(), byLabel: new Map() };
  const passthrough: Array<{ node: TreeNode; sortIndex: number }> = [];
  for (let i = 0; i < flatChildren.length; i++) {
    const node = flatChildren[i]!;
    // 键为 (行类型, 名字)：包 spec/body 同名双行可各自独立成组员；同名首行别名供历史条目按名匹配。
    if (rowTypes[node.type] && !rows.byKey.has(tableRowKey(node.type, node.label))) {
      rows.byKey.set(tableRowKey(node.type, node.label), { node, flatIndex: i });
      if (!rows.byLabel.has(node.label)) rows.byLabel.set(node.label, { node, flatIndex: i });
    } else passthrough.push({ node, sortIndex: i });
  }
  if (!rows.byKey.size) return flatChildren;

  const rootBuilt = buildVGroupRootNodes(activeLayout.order, activeLayout, rows, scope);
  // Rows the layout does not reference stay ungrouped at their original slot.
  const consumed = new Set<TreeNode>();
  const consume = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (rowTypes[node.type]) consumed.add(node);
      else consume(node.children ?? []);
    }
  };
  consume(rootBuilt.map((item) => item.node));
  for (const row of rows.byKey.values()) {
    if (!consumed.has(row.node)) passthrough.push({ node: row.node, sortIndex: row.flatIndex });
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
 * Find the live tree node whose children this scope's layout projects. Rows
 * and their container do not always carry identical optional identity fields
 * (a simple-display database node has no schema while its rows do), so
 * optional parts tolerate a missing value on either side; when several
 * containers match, the one that actually holds member rows wins. A member
 * type narrows candidates to containers of a matching kind, and so does a
 * non-tables scope.objectType — without that, reprojection triggered by, say,
 * a functions-layout change could fall back onto the database container and
 * strip the tables grouping out of it.
 */
export function findTableVGroupContainerNode(nodes: TreeNode[], scope: TableVGroupScope, memberLabel?: string, memberType?: string): TreeNode | null {
  const matchesOptional = (nodeValue: string | undefined, scopeValue: string | undefined) => nodeValue === scopeValue || !nodeValue || !scopeValue;
  // 目标类别：memberType（行解析）按成员类型收敛；scope.objectType（重投影）按
  // 类别收敛；tables 作用域（缺省）也必须收敛到 tables——否则其它类别的容器会混入
  // 候选池，tables 的无成员写入（建组/改名/折叠等）可能误路由过去并抹掉其分组投影。
  const scopeKind = scope.objectType && scope.objectType !== "tables" ? scope.objectType : null;
  const expectedKind = scopeKind ?? (memberType ? null : "tables");
  const memberRowTypes = memberType ? { [memberType]: true as const } : TABLE_VGROUP_KIND_ROW_TYPES[scope.objectType ?? "tables"];
  const candidates: TreeNode[] = [];
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      const kind = tableVGroupKindOfContainerNode(node);
      const kindMatches = expectedKind ? kind === expectedKind : kind !== null && TABLE_VGROUP_KIND_ROW_TYPES[kind][memberType!];
      if (
        kindMatches &&
        isTableVGroupContainerNode(node) &&
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

  if (memberLabel) {
    const holder = candidates.find((node) => (node.children ?? []).some((child) => memberRowTypes[child.type] && child.label === memberLabel));
    if (holder) return holder;
  }
  return candidates.find((node) => (node.children ?? []).some((child) => memberRowTypes[child.type] || child.type === "table-vgroup")) ?? candidates[0]!;
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
    // 同一层里重复的成员条目或分组引用会投影出重复节点（渲染以 id 作 key），
    // 损坏的持久化数据必须在归一化这一步收敛。去重键含行类型：包 spec/body
    // 同名双行是合法共存，不算重复。
    const seenTableNames = new Set<string>();
    const seenGroupEntries = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as Partial<TableVGroupOrderEntry>;
      if (candidate.type === "table") {
        const rowType = typeof candidate.rowType === "string" ? candidate.rowType : undefined;
        const dedupeKey = `${rowType ?? ""}\u0000${candidate.name}`;
        if (typeof candidate.name !== "string" || !candidate.name || seenTableNames.has(dedupeKey)) continue;
        seenTableNames.add(dedupeKey);
        out.push({ type: "table", name: candidate.name, ...(rowType ? { rowType } : {}) });
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

/** 节点到根路径上最近的「可分组容器」；投影分组行的类别由它决定。 */
function findTableVGroupHolderContainer(nodes: TreeNode[], node: TreeNode): TreeNode | null {
  const walk = (list: TreeNode[], ancestors: TreeNode[]): TreeNode | null => {
    for (const item of list) {
      if (item === node || item.id === node.id) {
        for (let i = ancestors.length - 1; i >= 0; i--) {
          const ancestor = ancestors[i]!;
          if (tableVGroupKindOfContainerNode(ancestor)) return ancestor;
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
 * Derive the layout scope for any sidebar row. Containers and projected group
 * rows resolve identity fields up to their host container (simple display
 * modes fill row-side schema fields the container lacks; using them would
 * split reads and writes across two keys) while the container kind comes from
 * the nearest groupable holder. Groupable rows resolve to the container of
 * their own type; when none exists (a view row in a mixed simple list, say)
 * the empty scope fails scope-key derivation so the row can never join a
 * tables-kind layout.
 */
export function resolveTableVGroupScopeFromNode(nodes: TreeNode[], node: TreeNode | TableVGroupScope): TableVGroupScope {
  const row = node as Partial<TreeNode> & TableVGroupScope;
  const containerKind = isTableVGroupContainerNode(row as TreeNode) ? tableVGroupKindOfContainerNode(row as TreeNode) : null;
  if (containerKind) return { ...tableVGroupScopeFieldsOf(tableVGroupScopeHostOf(nodes, row as TreeNode)), objectType: containerKind };
  if (row.type === "table-vgroup" || row.type?.startsWith("group-")) {
    const host = tableVGroupScopeHostOf(nodes, row as TreeNode);
    const holder = findTableVGroupHolderContainer(nodes, row as TreeNode);
    return { ...tableVGroupScopeFieldsOf(host), objectType: (holder && tableVGroupKindOfContainerNode(holder)) || "tables" };
  }
  if (row.type && isTableVGroupGroupableRowType(row.type)) {
    const holder = findTableVGroupContainerNode(nodes, tableVGroupScopeFieldsOf(row as TreeNode), row.label, row.type);
    // holder 子树（含投影出的分组层级）必须直接持有该行（同 id）：label 在跨容器
    // 同名时会误配——表结构子组里的触发器行与库级触发器列表的行同名不同节点；
    // 而「子树」而非「顶层」是因为已入组的成员行挂在 table-vgroup 行下，仍属
    // 同一容器的管辖范围（移出/换组动作就是从这里发起的）。
    const holdsRow = (nodes?: TreeNode[]): boolean => (nodes ?? []).some((n) => n.id === row.id || (n.type === "table-vgroup" && holdsRow(n.children)));
    if (!holder || !holdsRow(holder.children)) return {};
    const host = tableVGroupScopeHostOf(nodes, holder);
    return { ...tableVGroupScopeFieldsOf(host), objectType: tableVGroupKindOfContainerNode(holder) ?? "tables" };
  }
  const container = findTableVGroupContainerNode(nodes, row as TreeNode);
  return tableVGroupScopeFieldsOf(container ? tableVGroupScopeHostOf(nodes, container) : (row as TreeNode));
}

/**
 * Whether a drag with the given source row type may land on this container or
 * projected group row. Cross-kind drops would write phantom members into the
 * other kind's layout (and same-label members could evict real ones), so the
 * drop target resolution has to reject them up front.
 */
export function tableVGroupDropAcceptsRow(nodes: TreeNode[], target: TreeNode, rowType: TreeNode["type"]): boolean {
  const kind = target.type === "table-vgroup" ? tableVGroupKindOfContainerNode(findTableVGroupHolderContainer(nodes, target) ?? target) : tableVGroupKindOfContainerNode(target);
  return !!kind && !!TABLE_VGROUP_KIND_ROW_TYPES[kind][rowType];
}

/**
 * 任意深度出现分页游标都说明列表不完整：TDengine 等把末页游标嵌在 STABLE 的子表
 * 分区节点下，只看顶层会把部分页当成全量，进而误删分组成员。
 */
export function hasTableTreeLoadMore(nodes: readonly TreeNode[]): boolean {
  return nodes.some((node) => node.type === "load-more" || (node.children ? hasTableTreeLoadMore(node.children) : false));
}

/** 收集子树里可分组行名；多收只会让回收更保守，不会误删成员。 */
export function collectTableTreeNames(nodes: readonly TreeNode[], kind: TableVGroupObjectKind = "tables"): Set<string> {
  const rowTypes = TABLE_VGROUP_KIND_ROW_TYPES[kind];
  const names = new Set<string>();
  const walk = (list: readonly TreeNode[]) => {
    for (const node of list) {
      if (rowTypes[node.type] && node.label) names.add(node.label);
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
