import type { TreeNode } from "@/types/database";
import { objectTypesForGroupNode } from "@/lib/table/tableTree";

export type SidebarObjectDisplayMode = "simple" | "grouped";

const TABLE_STRUCTURE_GROUP_TYPES = new Set<TreeNode["type"]>(["group-columns", "group-indexes", "group-fkeys", "group-triggers", "group-partitions"]);

/** Whether a node's in-memory children match a valid "loaded" marker (scheme A). */
export function treeNodeLoadedChildrenContentPresent(node: TreeNode, sidebarObjectDisplay: SidebarObjectDisplayMode): boolean {
  const childCount = node.children?.length ?? 0;
  if (node.type === "database" || node.type === "schema" || node.type === "linked-server-schema") {
    if (childCount > 0) return true;
    // Grouped mode always materializes object-group placeholders; empty means a stale shell.
    return sidebarObjectDisplay === "simple";
  }
  if (objectTypesForGroupNode(node.type) || TABLE_STRUCTURE_GROUP_TYPES.has(node.type) || node.type === "group-extensions") {
    return true;
  }
  return childCount > 0;
}

/** Simple-mode empty database/schema nodes need an explicit confirmed-empty load, not just a marker. */
export function simpleModeEmptyShellNeedsConfirmedLoad(node: TreeNode, sidebarObjectDisplay: SidebarObjectDisplayMode): boolean {
  if (sidebarObjectDisplay !== "simple") return false;
  if (node.type !== "database" && node.type !== "schema" && node.type !== "linked-server-schema") return false;
  return (node.children?.length ?? 0) === 0;
}
