/**
 * Connection multi-selection state for the sidebar tree.
 *
 * The transitions live here rather than in the components because the checkbox
 * that grows the selection and the bulk actions that release it sit in two
 * different files, and only their combination decides what the next bulk action
 * operates on.
 */
export type ConnectionMultiSelection = {
  connectionIds: string[];
  activeConnectionId: string | null;
  anchorConnectionId: string | null;
  active: boolean;
};

/** The tree selection fields a multi-selection is written back to. */
export type ConnectionMultiSelectionTarget = {
  selectedTreeNodeIds: string[];
  selectedTreeNodeId: string | null;
  treeSelectionAnchorId: string | null;
  connectionMultiSelectActive: boolean;
};

export type TreeNodeSelection = {
  nodeIds: string[];
  activeNodeId: string | null;
  anchorNodeId: string | null;
};

export function isExitConnectionMultiSelectionShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): boolean {
  return event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
}

export function emptyConnectionMultiSelection(): ConnectionMultiSelection {
  return { connectionIds: [], activeConnectionId: null, anchorConnectionId: null, active: false };
}

/**
 * Ticking a checkbox adds to the current selection while multi-select is on, and
 * starts a new one when it is off. A bulk action that forgets to release the
 * selection therefore hands its connections to the next one (issue #5758).
 */
export function connectionMultiSelectionAfterToggle(selection: Pick<ConnectionMultiSelection, "connectionIds" | "active">, connectionId: string): ConnectionMultiSelection {
  const next = new Set(selection.active ? selection.connectionIds : []);
  if (next.has(connectionId)) next.delete(connectionId);
  else next.add(connectionId);

  const connectionIds = [...next];
  return {
    connectionIds,
    activeConnectionId: next.has(connectionId) ? connectionId : (connectionIds[0] ?? null),
    anchorConnectionId: connectionId,
    active: connectionIds.length > 0,
  };
}

export function applyConnectionMultiSelection(target: ConnectionMultiSelectionTarget, selection: ConnectionMultiSelection): void {
  target.selectedTreeNodeIds = selection.connectionIds;
  target.selectedTreeNodeId = selection.activeConnectionId;
  target.treeSelectionAnchorId = selection.anchorConnectionId;
  target.connectionMultiSelectActive = selection.active;
}

/**
 * Keep modifier-key connection selection aligned with the checkbox mode. Mixed
 * tree selections remain regular tree selections because connection-only bulk
 * actions must never consume database or object nodes.
 */
export function applyTreeNodeSelection(target: ConnectionMultiSelectionTarget, selection: TreeNodeSelection, connectionIds: ReadonlySet<string>): void {
  target.selectedTreeNodeIds = selection.nodeIds;
  target.selectedTreeNodeId = selection.activeNodeId;
  target.treeSelectionAnchorId = selection.anchorNodeId;
  target.connectionMultiSelectActive = selection.nodeIds.length > 0 && selection.nodeIds.every((id) => connectionIds.has(id));
}

export function releaseConnectionFromMultiSelection(target: ConnectionMultiSelectionTarget, connectionId: string): void {
  if (!target.connectionMultiSelectActive || !target.selectedTreeNodeIds.includes(connectionId)) return;

  const connectionIds = target.selectedTreeNodeIds.filter((id) => id !== connectionId);
  const activeConnectionId = target.selectedTreeNodeId && connectionIds.includes(target.selectedTreeNodeId) ? target.selectedTreeNodeId : (connectionIds[0] ?? null);
  const anchorConnectionId = target.treeSelectionAnchorId && connectionIds.includes(target.treeSelectionAnchorId) ? target.treeSelectionAnchorId : activeConnectionId;
  applyConnectionMultiSelection(target, {
    connectionIds,
    activeConnectionId,
    anchorConnectionId,
    active: connectionIds.length > 0,
  });
}
