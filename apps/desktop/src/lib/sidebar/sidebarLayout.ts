import type { ConnectionConfig, ConnectionGroup, SidebarLayout, SidebarOrderEntry, TreeNode } from "@/types/database";
import { uuid } from "@/lib/common/utils";
import { orderPinnedTreeNodes } from "@/lib/app/pinnedItems";

export function emptyLayout(): SidebarLayout {
  return { groups: [], order: [] };
}

export function hasSidebarLayoutEntries(layout: SidebarLayout | null | undefined): layout is SidebarLayout {
  return !!layout && (layout.groups.length > 0 || layout.order.length > 0);
}

function folderPathSegments(path: string | undefined): string[] {
  return (path ?? "").split("/").filter((segment) => segment.length > 0);
}

export function buildSidebarLayoutFromFolderPaths(connectionIds: string[], folderPaths: Iterable<string>, connectionFolderPaths: ReadonlyMap<string, string>): SidebarLayout | undefined {
  const groups: ConnectionGroup[] = [];
  const order: SidebarOrderEntry[] = [];
  const groupEntries = new Map<string, Extract<SidebarOrderEntry, { type: "group" }>>();

  const ensureFolder = (path: string | undefined) => {
    const segments = folderPathSegments(path);
    let parentEntry: Extract<SidebarOrderEntry, { type: "group" }> | undefined;
    let currentPath = "";

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let entry = groupEntries.get(currentPath);
      if (!entry) {
        const groupId = uuid();
        entry = { type: "group", id: groupId, children: [] };
        groupEntries.set(currentPath, entry);
        groups.push({ id: groupId, name: segment, collapsed: false });
        if (parentEntry) parentEntry.children!.push(entry);
        else order.push(entry);
      }
      parentEntry = entry;
    }

    return parentEntry;
  };

  for (const folderPath of folderPaths) ensureFolder(folderPath);

  for (const connectionId of connectionIds) {
    const connectionEntry: SidebarOrderEntry = { type: "connection", id: connectionId };
    const folderEntry = ensureFolder(connectionFolderPaths.get(connectionId));
    if (folderEntry) folderEntry.children!.push(connectionEntry);
    else order.push(connectionEntry);
  }

  return groups.length ? { groups, order } : undefined;
}

function entryChildren(entry: Extract<SidebarOrderEntry, { type: "group" }>): SidebarOrderEntry[] {
  return entry.children ?? entry.connectionIds?.map((id) => ({ type: "connection" as const, id })) ?? [];
}

function normalizeEntry(entry: SidebarOrderEntry, validIds: Set<string>, validGroups: Set<string>, seenConnections: Set<string>, seenGroups: Set<string>): SidebarOrderEntry | null {
  if (entry.type === "connection") {
    if (!validIds.has(entry.id) || seenConnections.has(entry.id)) return null;
    seenConnections.add(entry.id);
    return { type: "connection", id: entry.id };
  }

  if (!validGroups.has(entry.id) || seenGroups.has(entry.id)) return null;
  seenGroups.add(entry.id);

  const children = entryChildren(entry)
    .map((child) => normalizeEntry(child, validIds, validGroups, seenConnections, seenGroups))
    .filter(Boolean) as SidebarOrderEntry[];
  return { type: "group", id: entry.id, children };
}

export function reconcileLayout(connectionIds: string[], layout: SidebarLayout | null): SidebarLayout {
  if (!layout) {
    return {
      groups: [],
      order: connectionIds.map((id) => ({ type: "connection" as const, id })),
    };
  }

  const validIds = new Set(connectionIds);
  const validGroups = new Set(layout.groups.map((group) => group.id));
  const seenConnections = new Set<string>();
  const seenGroups = new Set<string>();
  const order = layout.order.map((entry) => normalizeEntry(entry, validIds, validGroups, seenConnections, seenGroups)).filter(Boolean) as SidebarOrderEntry[];

  for (const id of connectionIds) {
    if (!seenConnections.has(id)) {
      order.push({ type: "connection", id });
    }
  }

  const usedGroupIds = new Set<string>();
  const collectGroups = (entries: SidebarOrderEntry[]) => {
    for (const entry of entries) {
      if (entry.type !== "group") continue;
      usedGroupIds.add(entry.id);
      collectGroups(entryChildren(entry));
    }
  };
  collectGroups(order);

  const groups = layout.groups.filter((group) => usedGroupIds.has(group.id));
  return { groups, order };
}

/**
 * Keep only the selected connections and drop groups that become empty.
 * Unlike {@link reconcileLayout}, missing selected ids are not appended as
 * ungrouped leftovers — the caller already owns the selected set.
 */
export function filterSidebarLayoutByConnectionIds(layout: SidebarLayout | null | undefined, connectionIds: Iterable<string>): SidebarLayout {
  const selectedIds = Array.from(new Set(Array.from(connectionIds).filter((id) => id.length > 0)));
  if (!layout) {
    return {
      groups: [],
      order: selectedIds.map((id) => ({ type: "connection" as const, id })),
    };
  }

  const validIds = new Set(selectedIds);
  const validGroups = new Set(layout.groups.map((group) => group.id));
  const seenConnections = new Set<string>();
  const seenGroups = new Set<string>();

  const prune = (entry: SidebarOrderEntry): SidebarOrderEntry | null => {
    if (entry.type === "connection") {
      if (!validIds.has(entry.id) || seenConnections.has(entry.id)) return null;
      seenConnections.add(entry.id);
      return { type: "connection", id: entry.id };
    }
    if (!validGroups.has(entry.id) || seenGroups.has(entry.id)) return null;
    seenGroups.add(entry.id);
    const children = entryChildren(entry).map(prune).filter(Boolean) as SidebarOrderEntry[];
    if (!children.length) return null;
    return { type: "group", id: entry.id, children };
  };

  const order = layout.order.map(prune).filter(Boolean) as SidebarOrderEntry[];
  const usedGroupIds = new Set<string>();
  const collectGroups = (entries: SidebarOrderEntry[]) => {
    for (const entry of entries) {
      if (entry.type !== "group") continue;
      usedGroupIds.add(entry.id);
      collectGroups(entry.children ?? []);
    }
  };
  collectGroups(order);

  return {
    groups: layout.groups.filter((group) => usedGroupIds.has(group.id)).map((group) => ({ ...group })),
    order,
  };
}

export function remapSidebarLayoutConnectionIds(layout: SidebarLayout, connectionIdMap: Map<string, string>): SidebarLayout {
  const remapEntries = (entries: SidebarOrderEntry[]): SidebarOrderEntry[] =>
    entries.flatMap((entry): SidebarOrderEntry[] => {
      if (entry.type === "connection") {
        const id = connectionIdMap.get(entry.id);
        return id ? [{ type: "connection", id }] : [];
      }

      const children = entryChildren(entry).flatMap((child): SidebarOrderEntry[] => remapEntries([child]));
      return [{ type: "group", id: entry.id, children }];
    });

  return {
    groups: layout.groups.map((group) => ({ ...group })),
    order: remapEntries(layout.order),
  };
}

/**
 * Merge an imported layout into the current one instead of replacing it.
 * Folders are matched by name within the same level so repeated imports reuse
 * them, and connections outside the imported set keep their current placement.
 */
export function mergeSidebarLayout(current: SidebarLayout, imported: SidebarLayout): SidebarLayout {
  const importedGroups = new Map(imported.groups.map((group) => [group.id, group]));
  const groups = current.groups.map((group) => ({ ...group }));
  const groupNameById = new Map(groups.map((group) => [group.id, group.name]));
  const order = cloneEntries(current.order);

  // The imported layout owns the placement of the connections it lists, so drop
  // their current entries first — otherwise they would end up listed twice.
  const importedConnectionIds: string[] = [];
  const collectConnections = (entries: SidebarOrderEntry[]) => {
    for (const entry of entries) {
      if (entry.type === "connection") importedConnectionIds.push(entry.id);
      else collectConnections(entryChildren(entry));
    }
  };
  collectConnections(imported.order);
  for (const id of importedConnectionIds) removeEntry(order, id);

  const merge = (target: SidebarOrderEntry[], source: SidebarOrderEntry[]) => {
    for (const entry of source) {
      if (entry.type === "connection") {
        target.push({ type: "connection", id: entry.id });
        continue;
      }

      const importedGroup = importedGroups.get(entry.id);
      if (!importedGroup) continue;

      let destination = target.find((candidate): candidate is Extract<SidebarOrderEntry, { type: "group" }> => candidate.type === "group" && groupNameById.get(candidate.id) === importedGroup.name);
      if (!destination) {
        // A fresh id keeps the merged tree free of collisions with the group ids
        // the current layout already uses.
        const id = uuid();
        destination = { type: "group", id, children: [] };
        groups.push({ ...importedGroup, id });
        groupNameById.set(id, importedGroup.name);
        target.push(destination);
      }
      destination.children ??= [];
      merge(destination.children, entryChildren(entry));
    }
  };
  merge(order, imported.order);

  return { groups, order };
}

export function connectionSidebarSearchAliases(config: Pick<ConnectionConfig, "host" | "username">): string[] {
  return [config.host, config.username].filter((value) => value.trim().length > 0);
}

function makeConnectionNode(config: ConnectionConfig, pinned: boolean): TreeNode {
  return {
    id: config.id,
    label: config.name,
    type: "connection",
    searchAliases: connectionSidebarSearchAliases(config),
    connectionId: config.id,
    isExpanded: false,
    children: [],
    pinned,
    // 连接备注复用 TreeNode.comment 通道，侧边栏按 sidebarObjectInfoMode 渲染。
    comment: config.note || null,
  };
}

export function buildTreeNodesFromLayout(layout: SidebarLayout, connections: ConnectionConfig[], pinnedIds: Set<string>): TreeNode[] {
  const configMap = new Map(connections.map((connection) => [connection.id, connection]));
  const groupMap = new Map(layout.groups.map((group) => [group.id, group]));

  const build = (entries: SidebarOrderEntry[]): TreeNode[] => {
    const nodes: TreeNode[] = [];
    for (const entry of entries) {
      if (entry.type === "connection") {
        const config = configMap.get(entry.id);
        if (config) nodes.push(makeConnectionNode(config, pinnedIds.has(entry.id)));
        continue;
      }

      const group = groupMap.get(entry.id);
      if (!group) continue;
      nodes.push({
        id: group.id,
        label: group.name,
        type: "connection-group",
        pinned: pinnedIds.has(group.id),
        isExpanded: !group.collapsed,
        children: orderPinnedTreeNodes(build(entryChildren(entry))),
      });
    }
    return nodes;
  };

  return orderPinnedTreeNodes(build(layout.order));
}

export function findConnectionLocation(layout: SidebarLayout, connectionId: string): { entries: SidebarOrderEntry[]; entryIndex: number; groupId?: string } | null {
  const visit = (entries: SidebarOrderEntry[], groupId?: string): { entries: SidebarOrderEntry[]; entryIndex: number; groupId?: string } | null => {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.type === "connection" && entry.id === connectionId) return { entries, entryIndex: i, groupId };
      if (entry.type === "group") {
        const found = visit(entryChildren(entry), entry.id);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(layout.order);
}

/**
 * Returns the display-name path for a connection's containing groups.
 * A top-level connection returns an empty path; an absent connection returns null.
 */
export function findConnectionGroupPath(layout: SidebarLayout, connectionId: string): string[] | null {
  const groupMap = new Map(layout.groups.map((group) => [group.id, group]));

  const visit = (entries: SidebarOrderEntry[], path: string[]): string[] | null => {
    for (const entry of entries) {
      if (entry.type === "connection") {
        if (entry.id === connectionId) return path;
        continue;
      }

      const group = groupMap.get(entry.id);
      if (!group) continue;
      const found = visit(entryChildren(entry), [...path, group.name]);
      if (found) return found;
    }
    return null;
  };

  return visit(layout.order, []);
}

/** Build all connection group paths in one traversal for list rendering. */
export function buildConnectionGroupPathMap(layout: SidebarLayout): Map<string, string[]> {
  const groupMap = new Map(layout.groups.map((group) => [group.id, group]));
  const paths = new Map<string, string[]>();

  const visit = (entries: SidebarOrderEntry[], path: string[]) => {
    for (const entry of entries) {
      if (entry.type === "connection") {
        paths.set(entry.id, path);
        continue;
      }

      const group = groupMap.get(entry.id);
      if (!group) continue;
      visit(entryChildren(entry), [...path, group.name]);
    }
  };

  visit(layout.order, []);
  return paths;
}

export interface ConnectionGroupDestinationRow {
  id: string;
  name: string;
  depth: number;
  path: string[];
}

/** Build selectable connection-group destinations in the same tree order as the sidebar. */
export function connectionGroupDestinationRows(layout: SidebarLayout): ConnectionGroupDestinationRow[] {
  const groupMap = new Map(layout.groups.map((group) => [group.id, group]));
  const rows: ConnectionGroupDestinationRow[] = [];
  const seen = new Set<string>();

  const visit = (entries: SidebarOrderEntry[], parentPath: string[]) => {
    for (const entry of entries) {
      if (entry.type !== "group" || seen.has(entry.id)) continue;
      const group = groupMap.get(entry.id);
      if (!group) continue;

      seen.add(entry.id);
      const path = [...parentPath, group.name];
      rows.push({ id: group.id, name: group.name, depth: parentPath.length, path });
      visit(entryChildren(entry), path);
    }
  };

  visit(layout.order, []);
  return rows;
}

/** Resolve the group implied by a selected group, connection, or descendant node. */
export function connectionGroupIdForSelection(layout: SidebarLayout, selectedNodeId?: string | null, selectedConnectionId?: string | null): string | null {
  if (selectedNodeId && connectionGroupDestinationRows(layout).some((group) => group.id === selectedNodeId)) return selectedNodeId;
  const connectionId = selectedConnectionId || selectedNodeId;
  if (!connectionId) return null;
  return findConnectionLocation(layout, connectionId)?.groupId ?? null;
}

function findGroupEntry(entries: SidebarOrderEntry[], groupId: string): Extract<SidebarOrderEntry, { type: "group" }> | null {
  for (const entry of entries) {
    if (entry.type !== "group") continue;
    if (entry.id === groupId) return entry;
    const found = findGroupEntry(entryChildren(entry), groupId);
    if (found) return found;
  }
  return null;
}

function cloneEntries(entries: SidebarOrderEntry[]): SidebarOrderEntry[] {
  return entries.map((entry) => (entry.type === "group" ? { type: "group", id: entry.id, children: cloneEntries(entryChildren(entry)) } : { ...entry }));
}

function removeEntry(entries: SidebarOrderEntry[], id: string): SidebarOrderEntry | null {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if ((entry.type === "connection" && entry.id === id) || (entry.type === "group" && entry.id === id)) {
      entries.splice(i, 1);
      return entry;
    }
    if (entry.type === "group") {
      const removed = removeEntry(entry.children ?? [], id);
      if (removed) return removed;
    }
  }
  return null;
}

function removeConnectionFromEntries(entries: SidebarOrderEntry[], connectionId: string): SidebarOrderEntry[] {
  const next = cloneEntries(entries);
  removeEntry(next, connectionId);
  return next;
}

function containsGroup(entry: SidebarOrderEntry, groupId: string): boolean {
  if (entry.type !== "group") return false;
  if (entry.id === groupId) return true;
  return entryChildren(entry).some((child) => containsGroup(child, groupId));
}

function expandGroup(layout: SidebarLayout, groupId: string): SidebarLayout {
  return {
    ...layout,
    groups: layout.groups.map((group) => (group.id === groupId ? { ...group, collapsed: false } : group)),
  };
}

export function moveConnectionToGroup(layout: SidebarLayout, connectionId: string, targetGroupId: string | null): SidebarLayout {
  const order = removeConnectionFromEntries(layout.order, connectionId);
  const entry: SidebarOrderEntry = { type: "connection", id: connectionId };

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

export type DropPosition = "before" | "after" | "inside";

export interface ReorderEntriesOptions {
  preserveSameGroupOrder?: boolean;
}

function findEntryParentGroupId(entries: SidebarOrderEntry[], entryId: string, parentGroupId: string | null = null): string | null | undefined {
  for (const entry of entries) {
    if (entry.id === entryId) return parentGroupId;
    if (entry.type !== "group") continue;
    const found = findEntryParentGroupId(entryChildren(entry), entryId, entry.id);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function reorderEntry(layout: SidebarLayout, draggedId: string, targetId: string, position: DropPosition): SidebarLayout {
  if (draggedId === targetId) return layout;

  const order = cloneEntries(layout.order);
  const dragged = removeEntry(order, draggedId);
  if (!dragged) return layout;

  if (dragged.type === "group" && containsGroup(dragged, targetId)) return layout;

  if (position === "inside") {
    const targetGroup = findGroupEntry(order, targetId);
    if (targetGroup) {
      targetGroup.children = [...(targetGroup.children ?? []), dragged];
      return { ...layout, order };
    }
  }

  const insertNear = (entries: SidebarOrderEntry[]): boolean => {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if ((entry.type === "connection" && entry.id === targetId) || (entry.type === "group" && entry.id === targetId)) {
        entries.splice(position === "after" ? i + 1 : i, 0, dragged);
        return true;
      }
      if (entry.type === "group" && insertNear(entry.children ?? [])) return true;
    }
    return false;
  };

  if (!insertNear(order)) order.push(dragged);
  return { ...layout, order };
}

export function reorderEntries(layout: SidebarLayout, draggedIds: string[], targetId: string, position: DropPosition, options: ReorderEntriesOptions = {}): SidebarLayout {
  let nextLayout = layout;
  for (const draggedId of draggedIds) {
    if (draggedId === targetId) continue;
    if (position === "inside" && options.preserveSameGroupOrder && findEntryParentGroupId(nextLayout.order, draggedId) === targetId) continue;
    nextLayout = reorderEntry(nextLayout, draggedId, targetId, position);
  }
  return nextLayout;
}

export function createGroup(layout: SidebarLayout, name: string, parentGroupId?: string | null): { layout: SidebarLayout; groupId: string } {
  const groupId = uuid();
  const group: ConnectionGroup = { id: groupId, name, collapsed: false };
  const order = cloneEntries(layout.order);
  const entry: SidebarOrderEntry = { type: "group", id: groupId, children: [] };
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
      groups: [...layout.groups, group].map((current) => (parentFound && current.id === parentGroupId ? { ...current, collapsed: false } : current)),
      order,
    },
  };
}

export function renameGroup(layout: SidebarLayout, groupId: string, name: string): SidebarLayout {
  return {
    ...layout,
    groups: layout.groups.map((group) => (group.id === groupId ? { ...group, name } : group)),
  };
}

export function connectionIdsInGroups(layout: SidebarLayout, groupIds: Iterable<string>): string[] {
  const targets = new Set(groupIds);
  if (!targets.size) return [];

  const connectionIds: string[] = [];
  const seenConnectionIds = new Set<string>();
  const collectConnections = (entries: SidebarOrderEntry[]) => {
    for (const entry of entries) {
      if (entry.type === "group") {
        collectConnections(entryChildren(entry));
      } else if (!seenConnectionIds.has(entry.id)) {
        seenConnectionIds.add(entry.id);
        connectionIds.push(entry.id);
      }
    }
  };
  const visit = (entries: SidebarOrderEntry[]) => {
    for (const entry of entries) {
      if (entry.type !== "group") continue;
      if (targets.has(entry.id)) collectConnections(entryChildren(entry));
      else visit(entryChildren(entry));
    }
  };
  visit(layout.order);
  return connectionIds;
}

/** 收集单个分组下的所有连接 ID（含嵌套子分组），供分组勾选框级联选中连接使用。 */
export function connectionIdsUnderGroup(layout: SidebarLayout, groupId: string): string[] {
  return connectionIdsInGroups(layout, [groupId]);
}

/** 收集分组自身及其下属所有含连接的子分组 ID，供级联选中时自动展开使用。 */
export function connectionBearingGroupIdsUnder(layout: SidebarLayout, groupId: string): string[] {
  const entry = findGroupEntry(layout.order, groupId);
  if (!entry) return [];
  const ids: string[] = [];
  const visit = (groupEntry: Extract<SidebarOrderEntry, { type: "group" }>): boolean => {
    let hasConnection = false;
    for (const child of entryChildren(groupEntry)) {
      if (child.type === "connection") hasConnection = true;
      else if (visit(child)) hasConnection = true;
    }
    if (hasConnection) ids.push(groupEntry.id);
    return hasConnection;
  };
  visit(entry);
  return ids;
}

/** 批量展开指定分组（collapsed 置为 false），无变化时返回原布局。 */
export function expandGroups(layout: SidebarLayout, groupIds: Iterable<string>): SidebarLayout {
  const targets = new Set(groupIds);
  if (!targets.size) return layout;
  let changed = false;
  const groups = layout.groups.map((group) => {
    if (!targets.has(group.id) || !group.collapsed) return group;
    changed = true;
    return { ...group, collapsed: false };
  });
  return changed ? { ...layout, groups } : layout;
}

export function deleteGroups(layout: SidebarLayout, groupIds: Iterable<string>): SidebarLayout {
  const targets = new Set(groupIds);
  if (!targets.size) return layout;

  const removedGroupIds = new Set<string>();
  const flattenDeletedGroup = (entry: Extract<SidebarOrderEntry, { type: "group" }>): SidebarOrderEntry[] => {
    removedGroupIds.add(entry.id);
    return entryChildren(entry).flatMap((child): SidebarOrderEntry[] => {
      if (child.type === "connection") return [{ ...child }];
      return flattenDeletedGroup(child);
    });
  };
  const removeGroups = (entries: SidebarOrderEntry[]): SidebarOrderEntry[] =>
    entries.flatMap((entry): SidebarOrderEntry[] => {
      if (entry.type === "connection") return [{ ...entry }];
      if (targets.has(entry.id)) return flattenDeletedGroup(entry);
      const children = removeGroups(entryChildren(entry));
      return [{ type: "group", id: entry.id, children }];
    });

  const order = removeGroups(layout.order);
  if (!removedGroupIds.size) return layout;
  return {
    groups: layout.groups.filter((group) => !removedGroupIds.has(group.id)),
    order,
  };
}

export function deleteGroup(layout: SidebarLayout, groupId: string): SidebarLayout {
  return deleteGroups(layout, [groupId]);
}

export function toggleGroupCollapsed(layout: SidebarLayout, groupId: string): SidebarLayout {
  return {
    ...layout,
    groups: layout.groups.map((group) => (group.id === groupId ? { ...group, collapsed: !group.collapsed } : group)),
  };
}

export function collapseAllGroups(layout: SidebarLayout): SidebarLayout {
  return {
    ...layout,
    groups: layout.groups.map((group) => (group.collapsed ? group : { ...group, collapsed: true })),
  };
}

export function removeConnectionFromSidebarLayout(layout: SidebarLayout, connectionId: string): SidebarLayout {
  return { ...layout, order: removeConnectionFromEntries(layout.order, connectionId) };
}

export function appendConnectionToLayout(layout: SidebarLayout, connectionId: string, groupId?: string | null): SidebarLayout {
  return moveConnectionToGroup(layout, connectionId, groupId ?? null);
}
