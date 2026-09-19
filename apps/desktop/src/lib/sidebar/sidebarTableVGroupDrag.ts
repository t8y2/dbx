import { shallowRef } from "vue";
import type { TreeNode } from "@/types/database";
import { findTreeNodeById } from "@/lib/sql/newQueryContext";
import { isTableVGroupContainerNode } from "@/lib/table/tableVGroup";

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
export function resolveTableVGroupDropTarget(x: number, y: number, treeNodes: TreeNode[], source: { connectionId?: string; database?: string; schema?: string }): TableVGroupDropTarget | null {
  // Some environments (and component-test DOMs) do not implement hit testing.
  const elements = typeof document.elementsFromPoint === "function" ? document.elementsFromPoint(x, y) : [];
  for (const element of elements) {
    const row = element.closest("[data-node-id]");
    const nodeId = row?.getAttribute("data-node-id");
    if (!nodeId) continue;
    const node = findTreeNodeById(treeNodes, nodeId);
    if (!node || node.connectionId !== source.connectionId || (node.database ?? "") !== (source.database ?? "")) continue;
    // 跨 schema：双方都声明且不同 → 拒绝（任一方未知则容忍，交给 database 校验兜底）。
    if (node.schema && source.schema && node.schema !== source.schema) continue;
    if (node.type === "table-vgroup" && node.vgroupId) return { node, groupId: node.vgroupId };
    if (isTableVGroupContainerNode(node)) return { node, groupId: null };
  }
  return null;
}
