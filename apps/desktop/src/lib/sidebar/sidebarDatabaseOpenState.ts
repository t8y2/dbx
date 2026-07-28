import type { TreeNode } from "@/types/database";

export function sidebarDatabaseOpenKey(connectionId: string, database: string): string {
  return `${connectionId}\x00${database}`;
}

export function isSidebarDatabaseOpened(node: TreeNode, isTreeNodeChildrenLoaded: (nodeId: string) => boolean): boolean {
  return (node.type === "database" || node.type === "mongo-db" || node.type === "vector-database") && !!node.connectionId && node.database != null && isTreeNodeChildrenLoaded(node.id);
}

/** Sidebar "open" visual: tree loaded and/or still referenced by an open editor tab. */
export function isSidebarDatabaseOpenForVisual(node: TreeNode, isTreeNodeChildrenLoaded: (nodeId: string) => boolean, openDatabaseKeys: ReadonlySet<string>): boolean {
  if (node.type !== "database" || !node.connectionId || node.database == null) {
    return false;
  }
  return isSidebarDatabaseOpened(node, isTreeNodeChildrenLoaded) || openDatabaseKeys.has(sidebarDatabaseOpenKey(node.connectionId, node.database));
}

export function canCloseSidebarDatabaseConnection(node: TreeNode, isTreeNodeChildrenLoaded: (nodeId: string) => boolean, isDatabaseUsedByOpenTab: (connectionId: string, database: string) => boolean = () => false): boolean {
  return node.type === "database" && !!node.connectionId && node.database != null && (isTreeNodeChildrenLoaded(node.id) || isDatabaseUsedByOpenTab(node.connectionId, node.database));
}
