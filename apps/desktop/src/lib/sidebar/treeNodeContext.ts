import type { TreeNode } from "@/types/database";

export const DEFAULT_DATABASE_TREE_LABEL = "tree.defaultDatabase";

export function hasTreeNodeDatabaseContext(node: Pick<TreeNode, "database">): node is Pick<TreeNode, "database"> & {
  database: string;
} {
  return node.database != null;
}

function schemaCacheKey(...parts: string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join(":");
}

export function treeNodeSchemaCachePrefix(node: TreeNode): string | null {
  if (node.type === "connection" && node.connectionId) {
    return `${schemaCacheKey(node.connectionId)}:`;
  }
  if (node.type === "database" && node.connectionId && hasTreeNodeDatabaseContext(node)) {
    return `${schemaCacheKey(node.connectionId, node.database)}:`;
  }
  if (node.type === "schema" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.schema) {
    return `${schemaCacheKey(node.connectionId, node.database, node.schema)}:`;
  }
  return null;
}

export function normalizeCataloglessDatabaseNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    const normalized = node.type === "database" && node.database === "" && !node.label.trim() ? { ...node, label: DEFAULT_DATABASE_TREE_LABEL } : node;

    return normalized.children
      ? {
          ...normalized,
          children: normalizeCataloglessDatabaseNodes(normalized.children),
        }
      : normalized;
  });
}
