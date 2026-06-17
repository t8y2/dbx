import type { ConnectionConfig, ConnectionGroup, SidebarLayout, SidebarOrderEntry, TreeNode } from "@/types/database";
import { uuid } from "@/lib/utils";

export function emptyLayout(): SidebarLayout {
  return { groups: [], order: [] };
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

function makeConnectionNode(config: ConnectionConfig, pinned: boolean): TreeNode {
  return {
    id: config.id,
    label: config.name,
    type: "connection",
    connectionId: config.id,
    isExpanded: false,
    children: [],
    pinned,
  };
}

function orderPinnedFirst(nodes: TreeNode[]): TreeNode[] {
  const pinned: TreeNode[] = [];
  const unpinned: TreeNode[] = [];
  for (const node of nodes) {
    if (node.pinned) pinned.push(node);
    else unpinned.push(node);
  }
  return [...pinned, ...unpinned];
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
        children: orderPinnedFirst(build(entryChildren(entry))),
      });
    }
    return nodes;
  };

  return orderPinnedFirst(build(layout.order));
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

export function createGroup(layout: SidebarLayout, name: string, parentGroupId?: string | null): { layout: SidebarLayout; groupId: string } {
  const groupId = uuid();
  const group: ConnectionGroup = { id: groupId, name, collapsed: false };
  const order = cloneEntries(layout.order);
  const entry: SidebarOrderEntry = { type: "group", id: groupId, children: [] };

  if (parentGroupId) {
    const parent = findGroupEntry(order, parentGroupId);
    if (parent) {
      parent.children = [...(parent.children ?? []), entry];
    } else {
      order.push(entry);
    }
  } else {
    order.push(entry);
  }

  return {
    groupId,
    layout: {
      groups: [...layout.groups, group],
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

export function deleteGroup(layout: SidebarLayout, groupId: string): SidebarLayout {
  const order = cloneEntries(layout.order);
  const removeGroup = (entries: SidebarOrderEntry[]): boolean => {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.type === "group" && entry.id === groupId) {
        entries.splice(i, 1, ...entryChildren(entry));
        return true;
      }
      if (entry.type === "group") {
        const removed = removeGroup(entry.children ?? []);
        if (removed) return true;
      }
    }
    return false;
  };

  const removed = removeGroup(order);
  return {
    groups: removed ? layout.groups.filter((group) => group.id !== groupId) : layout.groups,
    order,
  };
}

export function toggleGroupCollapsed(layout: SidebarLayout, groupId: string): SidebarLayout {
  return {
    ...layout,
    groups: layout.groups.map((group) => (group.id === groupId ? { ...group, collapsed: !group.collapsed } : group)),
  };
}

export function removeConnectionFromSidebarLayout(layout: SidebarLayout, connectionId: string): SidebarLayout {
  return { ...layout, order: removeConnectionFromEntries(layout.order, connectionId) };
}

export function appendConnectionToLayout(layout: SidebarLayout, connectionId: string, groupId?: string | null): SidebarLayout {
  return moveConnectionToGroup(layout, connectionId, groupId ?? null);
}
