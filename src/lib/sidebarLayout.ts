import type { ConnectionConfig, ConnectionGroup, SidebarLayout, SidebarOrderEntry, TreeNode } from "@/types/database";

export function emptyLayout(): SidebarLayout {
  return { groups: [], order: [] };
}

export function reconcileLayout(connectionIds: string[], layout: SidebarLayout | null): SidebarLayout {
  if (!layout) {
    return {
      groups: [],
      order: connectionIds.map((id) => ({ type: "connection" as const, id })),
    };
  }

  const validIds = new Set(connectionIds);
  const seen = new Set<string>();

  const order: SidebarOrderEntry[] = [];
  for (const entry of layout.order) {
    if (entry.type === "group") {
      const filtered = entry.connectionIds.filter((id) => {
        if (!validIds.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      order.push({ type: "group", id: entry.id, connectionIds: filtered });
    } else {
      if (validIds.has(entry.id) && !seen.has(entry.id)) {
        seen.add(entry.id);
        order.push(entry);
      }
    }
  }

  for (const id of connectionIds) {
    if (!seen.has(id)) {
      order.push({ type: "connection", id });
    }
  }

  const usedGroupIds = new Set(order.filter((e) => e.type === "group").map((e) => e.id));
  const groups = layout.groups.filter((g) => usedGroupIds.has(g.id));

  return { groups, order };
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

export function buildTreeNodesFromLayout(
  layout: SidebarLayout,
  connections: ConnectionConfig[],
  pinnedIds: Set<string>,
): TreeNode[] {
  const configMap = new Map(connections.map((c) => [c.id, c]));
  const groupMap = new Map(layout.groups.map((g) => [g.id, g]));

  const nodes: TreeNode[] = [];
  for (const entry of layout.order) {
    if (entry.type === "group") {
      const group = groupMap.get(entry.id);
      if (!group) continue;
      const children: TreeNode[] = [];
      for (const connId of entry.connectionIds) {
        const config = configMap.get(connId);
        if (config) children.push(makeConnectionNode(config, pinnedIds.has(connId)));
      }
      nodes.push({
        id: group.id,
        label: group.name,
        type: "connection-group",
        isExpanded: !group.collapsed,
        children: orderPinnedFirst(children),
      });
    } else {
      const config = configMap.get(entry.id);
      if (config) nodes.push(makeConnectionNode(config, pinnedIds.has(entry.id)));
    }
  }

  return orderPinnedFirst(nodes);
}

export function findConnectionLocation(layout: SidebarLayout, connectionId: string): { entryIndex: number; groupId?: string; innerIndex?: number } | null {
  for (let i = 0; i < layout.order.length; i++) {
    const entry = layout.order[i];
    if (entry.type === "connection" && entry.id === connectionId) {
      return { entryIndex: i };
    }
    if (entry.type === "group") {
      const innerIndex = entry.connectionIds.indexOf(connectionId);
      if (innerIndex >= 0) {
        return { entryIndex: i, groupId: entry.id, innerIndex };
      }
    }
  }
  return null;
}

function removeConnectionFromLayout(order: SidebarOrderEntry[], connectionId: string): SidebarOrderEntry[] {
  return order.map((entry) => {
    if (entry.type === "connection" && entry.id === connectionId) return null;
    if (entry.type === "group") {
      return { ...entry, connectionIds: entry.connectionIds.filter((id) => id !== connectionId) };
    }
    return entry;
  }).filter(Boolean) as SidebarOrderEntry[];
}

export function moveConnectionToGroup(layout: SidebarLayout, connectionId: string, targetGroupId: string | null): SidebarLayout {
  const order = removeConnectionFromLayout([...layout.order], connectionId);

  if (targetGroupId) {
    const groupEntry = order.find((e) => e.type === "group" && e.id === targetGroupId);
    if (groupEntry && groupEntry.type === "group") {
      groupEntry.connectionIds.push(connectionId);
    }
  } else {
    order.push({ type: "connection", id: connectionId });
  }

  return { ...layout, order };
}

export type DropPosition = "before" | "after" | "inside";

export function reorderEntry(
  layout: SidebarLayout,
  draggedId: string,
  targetId: string,
  position: DropPosition,
): SidebarLayout {
  if (draggedId === targetId) return layout;

  const isDraggedGroup = layout.order.some((e) => e.type === "group" && e.id === draggedId);
  const isTargetGroup = layout.order.some((e) => e.type === "group" && e.id === targetId);

  if (isDraggedGroup) {
    return reorderGroup(layout, draggedId, targetId, position);
  }

  if (position === "inside" && isTargetGroup) {
    return moveConnectionToGroup(layout, draggedId, targetId);
  }

  return reorderConnection(layout, draggedId, targetId, position);
}

function reorderGroup(layout: SidebarLayout, draggedId: string, targetId: string, position: DropPosition): SidebarLayout {
  const order = [...layout.order];
  const draggedIndex = order.findIndex((e) => e.type === "group" && e.id === draggedId);
  if (draggedIndex < 0) return layout;

  const [dragged] = order.splice(draggedIndex, 1);

  let targetIndex = order.findIndex((e) => (e.type === "group" && e.id === targetId) || (e.type === "connection" && e.id === targetId));
  if (targetIndex < 0) {
    order.push(dragged);
  } else {
    if (position === "after") targetIndex++;
    order.splice(targetIndex, 0, dragged);
  }

  return { ...layout, order };
}

function reorderConnection(layout: SidebarLayout, draggedId: string, targetId: string, position: DropPosition): SidebarLayout {
  const order = removeConnectionFromLayout([...layout.order], draggedId);

  const targetLoc = findConnectionLocation({ ...layout, order }, targetId);
  if (!targetLoc) {
    order.push({ type: "connection", id: draggedId });
    return { ...layout, order };
  }

  if (targetLoc.groupId) {
    const groupEntry = order[targetLoc.entryIndex];
    if (groupEntry.type === "group") {
      const insertAt = position === "after" ? targetLoc.innerIndex! + 1 : targetLoc.innerIndex!;
      groupEntry.connectionIds.splice(insertAt, 0, draggedId);
    }
  } else {
    const isTargetGroup = order[targetLoc.entryIndex]?.type === "group";
    if (isTargetGroup && position === "inside") {
      const entry = order[targetLoc.entryIndex];
      if (entry.type === "group") entry.connectionIds.push(draggedId);
    } else {
      const insertAt = position === "after" ? targetLoc.entryIndex + 1 : targetLoc.entryIndex;
      order.splice(insertAt, 0, { type: "connection", id: draggedId });
    }
  }

  return { ...layout, order };
}

export function createGroup(layout: SidebarLayout, name: string): { layout: SidebarLayout; groupId: string } {
  const groupId = crypto.randomUUID();
  const group: ConnectionGroup = { id: groupId, name, collapsed: false };
  return {
    groupId,
    layout: {
      groups: [...layout.groups, group],
      order: [...layout.order, { type: "group" as const, id: groupId, connectionIds: [] }],
    },
  };
}

export function renameGroup(layout: SidebarLayout, groupId: string, name: string): SidebarLayout {
  return {
    ...layout,
    groups: layout.groups.map((g) => g.id === groupId ? { ...g, name } : g),
  };
}

export function deleteGroup(layout: SidebarLayout, groupId: string): SidebarLayout {
  const order: SidebarOrderEntry[] = [];
  for (const entry of layout.order) {
    if (entry.type === "group" && entry.id === groupId) {
      for (const connId of entry.connectionIds) {
        order.push({ type: "connection", id: connId });
      }
    } else {
      order.push(entry);
    }
  }
  return {
    groups: layout.groups.filter((g) => g.id !== groupId),
    order,
  };
}

export function toggleGroupCollapsed(layout: SidebarLayout, groupId: string): SidebarLayout {
  return {
    ...layout,
    groups: layout.groups.map((g) => g.id === groupId ? { ...g, collapsed: !g.collapsed } : g),
  };
}

export function removeConnectionFromSidebarLayout(layout: SidebarLayout, connectionId: string): SidebarLayout {
  return { ...layout, order: removeConnectionFromLayout(layout.order, connectionId) };
}

export function appendConnectionToLayout(layout: SidebarLayout, connectionId: string): SidebarLayout {
  return { ...layout, order: [...layout.order, { type: "connection" as const, id: connectionId }] };
}
