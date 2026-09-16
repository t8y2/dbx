import { shallowRef } from "vue";
import type { TreeNode } from "@/types/database";

/**
 * Shared drop feedback for dragging a table row onto a virtual group row.
 * The dragged row (any TreeItem) publishes the row under the pointer so the
 * hovered group can highlight itself; the pointer's own TreeItem applies the
 * membership change on release.
 */
export const tableVGroupDropTargetNodeId = shallowRef<string | null>(null);

export function setTableVGroupDropTargetNodeId(nodeId: string | null) {
  if (tableVGroupDropTargetNodeId.value !== nodeId) tableVGroupDropTargetNodeId.value = nodeId;
}

export function findTreeNodeById(nodes: readonly TreeNode[], nodeId: string): TreeNode | null {
  for (const node of nodes) {
    if (node.id === nodeId) return node;
    const found = node.children ? findTreeNodeById(node.children, nodeId) : null;
    if (found) return found;
  }
  return null;
}

/** Container rows accept a table drop as "remove from group". */
export function isTableVGroupContainerNode(node: TreeNode): boolean {
  return node.type === "database" || node.type === "schema" || node.type === "linked-server-schema" || node.type === "group-tables";
}

export interface TableVGroupDropTarget {
  node: TreeNode;
  groupId: string | null;
}

/**
 * Resolve the group (or "ungroup" container) a dragged table is released on.
 * Scans the whole element stack: the drag feedback chip and sticky headers sit
 * above the row, so a single elementFromPoint hit often misses it. Cross-scope
 * drops are rejected so a table name never lands in another database's layout.
 */
export function resolveTableVGroupDropTarget(x: number, y: number, treeNodes: readonly TreeNode[], source: { connectionId?: string; database?: string }): TableVGroupDropTarget | null {
  // Some environments (and component-test DOMs) do not implement hit testing.
  const elements = typeof document.elementsFromPoint === "function" ? document.elementsFromPoint(x, y) : [];
  for (const element of elements) {
    const row = element.closest("[data-node-id]");
    const nodeId = row?.getAttribute("data-node-id");
    if (!nodeId) continue;
    const node = findTreeNodeById(treeNodes, nodeId);
    if (!node || node.connectionId !== source.connectionId || (node.database ?? "") !== (source.database ?? "")) continue;
    if (node.type === "table-vgroup" && node.vgroupId) return { node, groupId: node.vgroupId };
    if (isTableVGroupContainerNode(node)) return { node, groupId: null };
  }
  return null;
}
