import type { TreeNode } from "@/types/database";

export function findDatabaseTreeNode(nodes: TreeNode[], connectionId: string, database: string): TreeNode | null {
  for (const node of nodes) {
    if (node.type === "database" && node.connectionId === connectionId && node.database === database) {
      return node;
    }
    if (node.children) {
      const found = findDatabaseTreeNode(node.children, connectionId, database);
      if (found) return found;
    }
  }
  return null;
}
