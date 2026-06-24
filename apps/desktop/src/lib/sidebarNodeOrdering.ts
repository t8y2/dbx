import type { DatabaseType, TreeNode } from "@/types/database";

const sidebarTreeCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function sortByLabel(nodes: readonly TreeNode[]): TreeNode[] {
  return [...nodes].sort((left, right) => sidebarTreeCollator.compare(left.label, right.label));
}

function sortRecursive(node: TreeNode, databaseType?: DatabaseType): TreeNode {
  const children = node.children ? sortSidebarTreeChildrenForParent(node, node.children, databaseType) : node.children;
  const hiddenChildren = node.hiddenChildren ? sortSidebarTreeChildrenForParent(node, node.hiddenChildren, databaseType) : node.hiddenChildren;
  if (children === node.children && hiddenChildren === node.hiddenChildren) return node;
  return {
    ...node,
    children,
    hiddenChildren,
  };
}

export function sortSidebarTreeChildrenForParent(parent: Pick<TreeNode, "type">, children: readonly TreeNode[], databaseType?: DatabaseType): TreeNode[] {
  const normalized = children.map((child) => sortRecursive(child, databaseType));

  if (parent.type === "mongo-db") {
    return sortByLabel(normalized);
  }

  if (parent.type === "connection") {
    const savedSqlNodes = normalized.filter((child) => child.type === "saved-sql-root");
    const userAdminNodes = normalized.filter((child) => child.type === "user-admin");
    const regularChildren = normalized.filter((child) => child.type !== "user-admin" && child.type !== "saved-sql-root");
    const withConnectionUtilityOrder = (children: TreeNode[]) => [...savedSqlNodes, ...children, ...userAdminNodes];

    if (databaseType === "mongodb" || databaseType === "elasticsearch" || databaseType === "qdrant" || databaseType === "milvus" || databaseType === "weaviate") {
      return withConnectionUtilityOrder(sortByLabel(regularChildren));
    }

    if (databaseType === "duckdb") {
      const schemas = sortByLabel(regularChildren.filter((child) => child.type === "schema"));
      const databases = sortByLabel(regularChildren.filter((child) => child.type === "database"));
      const rest = regularChildren.filter((child) => child.type !== "schema" && child.type !== "database");
      return withConnectionUtilityOrder([...schemas, ...databases, ...rest]);
    }

    if (regularChildren.every((child) => child.type === "database")) {
      return withConnectionUtilityOrder(sortByLabel(regularChildren));
    }

    if (regularChildren.every((child) => child.type === "schema")) {
      return withConnectionUtilityOrder(sortByLabel(regularChildren));
    }

    return withConnectionUtilityOrder(regularChildren);
  }

  if (parent.type === "database") {
    if (databaseType === "sqlserver") {
      const objectGroups = normalized.filter((child) => child.type.startsWith("group-"));
      const schemas = sortByLabel(normalized.filter((child) => child.type === "schema"));
      const rest = normalized.filter((child) => !child.type.startsWith("group-") && child.type !== "schema");
      return [...objectGroups, ...schemas, ...rest];
    }

    if (normalized.every((child) => child.type === "schema")) {
      return sortByLabel(normalized);
    }
  }

  return normalized;
}
