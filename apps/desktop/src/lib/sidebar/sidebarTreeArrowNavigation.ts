import type { FlatTreeNode } from "@/composables/useFlatTree";
import type { TreeNode } from "@/types/database";
import { canTreeNodeShowExpander } from "@/lib/sidebar/sidebarTreeItemLayout";

export type SidebarTreeArrowAction = { kind: "select"; nodeId: string } | { kind: "toggle"; nodeId: string; expanded: boolean } | { kind: "none" };

/**
 * Resolves the standard tree-navigation action (VS Code / file explorer
 * semantics) for an arrow key pressed on the row identified by
 * `currentNodeId`. Callers pass the visible rows they render, excluding
 * non-selectable pseudo rows (e.g. per-database table search controls), so
 * vertical movement naturally skips them.
 */
export function sidebarTreeArrowAction(rows: readonly FlatTreeNode[], currentNodeId: string, key: string): SidebarTreeArrowAction {
  const currentIndex = rows.findIndex((row) => row.id === currentNodeId);
  if (currentIndex < 0) return { kind: "none" };

  const current = rows[currentIndex]!;
  const node = current.node;

  if (key === "ArrowUp") {
    return currentIndex > 0 ? { kind: "select", nodeId: rows[currentIndex - 1]!.id } : { kind: "none" };
  }
  if (key === "ArrowDown") {
    return currentIndex < rows.length - 1 ? { kind: "select", nodeId: rows[currentIndex + 1]!.id } : { kind: "none" };
  }
  if (key === "ArrowRight") {
    const next = rows[currentIndex + 1];
    if (node.isExpanded && next && next.depth === current.depth + 1) return { kind: "select", nodeId: next.id };
    if (!node.isExpanded && isArrowExpandable(node)) return { kind: "toggle", nodeId: node.id, expanded: true };
    return { kind: "none" };
  }
  if (key === "ArrowLeft") {
    if (node.isExpanded && node.children?.length) return { kind: "toggle", nodeId: node.id, expanded: false };
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      if (rows[index]!.depth < current.depth) return { kind: "select", nodeId: rows[index]!.id };
    }
    return { kind: "none" };
  }
  return { kind: "none" };
}

function isArrowExpandable(node: TreeNode): boolean {
  return canTreeNodeShowExpander({
    type: node.type,
    childCount: node.children?.length ?? 0,
    explicitContainer: (node.type === "package" && node.children !== undefined) || node.xuguTypeMembersExpandable === true,
  });
}
