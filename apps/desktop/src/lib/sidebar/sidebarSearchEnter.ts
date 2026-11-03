import type { TreeNode, TreeNodeType } from "@/types/database";

// Row types whose single-click action opens the object's data. Pressing Enter
// in the sidebar search opens the first matching one of these.
const sidebarSearchOpenFirstNodeTypes = new Set<TreeNodeType>(["table", "view", "materialized_view"]);

/** True when any sidebar search surface (global query or per-database table search) is active. */
export function hasActiveSidebarSearch(globalQuery: string, tableSearchQueries: Readonly<Record<string, string>>): boolean {
  if (globalQuery.trim().length > 0) return true;
  return Object.values(tableSearchQueries).some((query) => query.trim().length > 0);
}

/**
 * The first visible data node a search should open on Enter, in tree display
 * order. Returns null when no table-like row is visible.
 */
export function firstSidebarSearchMatchDataNode(nodes: readonly TreeNode[], hasActiveSearch: boolean): TreeNode | null {
  if (!hasActiveSearch) return null;
  for (const node of nodes) {
    if (sidebarSearchOpenFirstNodeTypes.has(node.type)) return node;
  }
  return null;
}
