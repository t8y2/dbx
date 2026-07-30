import type { TreeNode } from "@/types/database";

export function findDatabaseTreeNode(nodes: TreeNode[], connectionId: string, database: string, catalog?: string): TreeNode | null {
  for (const node of nodes) {
    const catalogMatches = catalog ? node.catalog === catalog : !node.catalog;
    if (node.type === "database" && node.connectionId === connectionId && node.database === database && catalogMatches) {
      return node;
    }
    if (node.children) {
      const found = findDatabaseTreeNode(node.children, connectionId, database, catalog);
      if (found) return found;
    }
  }
  return null;
}
