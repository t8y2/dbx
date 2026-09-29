import type { TreeNode, TreeNodeType } from "@/types/database";
import { sidebarDatabaseOpenKey } from "@/lib/sidebar/sidebarDatabaseOpenState";

// Database-level containers whose objects the sidebar search walker may load.
// Mirrors the sidebar "database opened" indicator (sidebarDatabaseOpenState):
// a database participates in the automatic search only when the user actually
// opened it — children loaded in the tree or referenced by an open editor tab.
const searchScopeDatabaseTypes = new Set<TreeNodeType>(["database", "mongo-db", "vector-database"]);

export interface SidebarSearchDatabaseScopeOptions {
  enabled: boolean;
  isChildrenLoaded: (nodeId: string) => boolean;
  openDatabaseKeys: ReadonlySet<string>;
}

function collectOpenedDatabaseNodeIds(node: TreeNode, opened: Set<string>, options: SidebarSearchDatabaseScopeOptions): void {
  for (const child of node.children ?? []) {
    if (searchScopeDatabaseTypes.has(child.type)) {
      const isOpened = !!child.connectionId && child.database != null && (options.isChildrenLoaded(child.id) || options.openDatabaseKeys.has(sidebarDatabaseOpenKey(child.connectionId, child.database)));
      if (isOpened) opened.add(child.id);
      // Nothing below a database-level node is itself database-level, so the
      // subtree never contributes another scope entry.
      continue;
    }
    // Pass-through containers (connection groups, Doris catalogs, linked
    // servers) keep their nested database nodes scannable.
    collectOpenedDatabaseNodeIds(child, opened, options);
  }
}

/**
 * Node ids of database-level nodes the sidebar search may load for one
 * connection, or null when the search must stay unrestricted.
 *
 * null means either the setting is off, the connection exposes no
 * database-level nodes (schema-mode trees such as Oracle, Redis, etc.), or
 * none of them is opened — in that case falling back to searching every
 * database keeps the box useful right after connecting, before the user
 * opens anything.
 */
export function resolveSidebarSearchDatabaseScope(connectionNode: TreeNode, options: SidebarSearchDatabaseScopeOptions): ReadonlySet<string> | null {
  if (!options.enabled) return null;
  const opened = new Set<string>();
  collectOpenedDatabaseNodeIds(connectionNode, opened, options);
  return opened.size > 0 ? opened : null;
}

/**
 * Whether the search walker must skip a node: a database-level node outside
 * the opened scope. Containers and non-database nodes are never pruned, and a
 * null scope (unrestricted) prunes nothing.
 */
export function isSidebarSearchPrunedDatabaseNode(node: TreeNode, scope: ReadonlySet<string> | null): boolean {
  if (!scope) return false;
  return searchScopeDatabaseTypes.has(node.type) && !scope.has(node.id);
}
