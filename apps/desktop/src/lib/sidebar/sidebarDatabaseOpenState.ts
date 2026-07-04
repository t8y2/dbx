import type { TreeNode } from "@/types/database";

export function isSidebarDatabaseOpened(node: TreeNode, isTreeNodeChildrenLoaded: (nodeId: string) => boolean): boolean {
  return (node.type === "database" || node.type === "mongo-db") && !!node.connectionId && node.database != null && isTreeNodeChildrenLoaded(node.id);
}

export function canCloseSidebarDatabaseConnection(node: TreeNode, isTreeNodeChildrenLoaded: (nodeId: string) => boolean): boolean {
  return node.type === "database" && !!node.connectionId && node.database != null && isTreeNodeChildrenLoaded(node.id);
}
