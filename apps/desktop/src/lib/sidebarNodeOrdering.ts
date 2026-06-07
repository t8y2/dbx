import type { DatabaseType, TreeNode } from "@/types/database";

const sidebarTreeCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function sortByLabel(nodes: readonly TreeNode[]): TreeNode[] {
  return [...nodes].sort((left, right) => sidebarTreeCollator.compare(left.label, right.label));
}

function sortRecursive(node: TreeNode, databaseType?: DatabaseType): TreeNode {
  const children = node.children ? sortSidebarTreeChildrenForParent(node, node.children, databaseType) : node.children;
  const hiddenChildren = node.hiddenChildren
    ? sortSidebarTreeChildrenForParent(node, node.hiddenChildren, databaseType)
    : node.hiddenChildren;
  if (children === node.children && hiddenChildren === node.hiddenChildren) return node;
  return {
    ...node,
    children,
    hiddenChildren,
  };
}

export function sortSidebarTreeChildrenForParent(
  parent: Pick<TreeNode, "type">,
  children: readonly TreeNode[],
  databaseType?: DatabaseType,
): TreeNode[] {
  const normalized = children.map((child) => sortRecursive(child, databaseType));

  if (parent.type === "mongo-db") {
    return sortByLabel(normalized);
  }

  if (parent.type === "connection") {
    if (databaseType === "mongodb" || databaseType === "elasticsearch") {
      return sortByLabel(normalized);
    }

    if (databaseType === "duckdb") {
      const schemas = sortByLabel(normalized.filter((child) => child.type === "schema"));
      const databases = sortByLabel(normalized.filter((child) => child.type === "database"));
      const rest = normalized.filter((child) => child.type !== "schema" && child.type !== "database");
      return [...schemas, ...databases, ...rest];
    }

    if (normalized.every((child) => child.type === "database")) {
      return sortByLabel(normalized);
    }

    if (normalized.every((child) => child.type === "schema")) {
      return sortByLabel(normalized);
    }
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
