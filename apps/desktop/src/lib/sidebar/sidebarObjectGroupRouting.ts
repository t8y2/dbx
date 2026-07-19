import type { TreeNode } from "@/types/database";
import { hasTreeNodeDatabaseContext } from "@/lib/sidebar/treeNodeContext";
import { objectTypesForGroupNode } from "@/lib/table/tableTree";

export interface SidebarObjectGroupLoaders {
  loadTriggers(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string): Promise<void>;
  loadObjectGroupChildren(node: TreeNode): Promise<void>;
}

/**
 * Loads object-group metadata from the same path used by the sidebar toggle.
 * Table trigger groups are special because they are scoped to one table;
 * schema-level trigger groups are regular database object groups.
 */
export async function loadSidebarObjectGroup(node: TreeNode, loaders: SidebarObjectGroupLoaders): Promise<boolean> {
  if (node.type === "group-triggers" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
    await loaders.loadTriggers(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    return true;
  }

  if (!objectTypesForGroupNode(node.type)) return false;
  await loaders.loadObjectGroupChildren(node);
  return true;
}
