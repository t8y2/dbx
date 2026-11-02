import type { TreeNode, TreeNodeType } from "@/types/database";

/**
 * Whether a sidebar search still has to fetch a container's on-demand object
 * groups before it can look for matches below it.
 *
 * A collapsed container is not necessarily childless: every database keeps its
 * saved-SQL root (`tree.queries`) as a child even before the object groups are
 * fetched, so "no children" is not a reliable discovery signal. Checking for a
 * searchable group instead keeps databases whose groups were never loaded out
 * of the search, which made a table that exists in several databases appear
 * under only one of them.
 */
export function needsSidebarObjectGroupDiscovery(node: TreeNode, objectGroupTypes: ReadonlySet<TreeNodeType>): boolean {
  return !node.children?.some((child) => child.connectionId != null && objectGroupTypes.has(child.type));
}
