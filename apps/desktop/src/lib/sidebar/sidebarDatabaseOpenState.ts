import type { TreeNode } from "@/types/database";

export function isSidebarDatabaseOpened(node: TreeNode, isTreeNodeChildrenLoaded: (nodeId: string) => boolean): boolean {
  return (node.type === "database" || node.type === "mongo-db" || node.type === "vector-database") && !!node.connectionId && node.database != null && isTreeNodeChildrenLoaded(node.id);
}

export function canCloseSidebarDatabaseConnection(node: TreeNode, isTreeNodeChildrenLoaded: (nodeId: string) => boolean, isDatabaseUsedByOpenTab: (connectionId: string, database: string) => boolean = () => false): boolean {
  return node.type === "database" && !!node.connectionId && node.database != null && (isTreeNodeChildrenLoaded(node.id) || isDatabaseUsedByOpenTab(node.connectionId, node.database));
}
