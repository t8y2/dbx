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

/**
 * Virtual table groups are a display-level projection (see
 * `applyTableVGroupsToChildren`) whose order comes from the stored layout, not
 * from the alphabet. Every ordering pass therefore has to leave them ahead of
 * the flat rows: a name-sorted metadata merge would otherwise drop a group back
 * to its alphabetical slot, and the row would visibly jump from the top of the
 * list to the bottom until the next projection ran (issues #9644 / #9653).
 */
function hoistTableVGroupChildren(nodes: TreeNode[]): TreeNode[] {
  if (!nodes.some((node) => node.type === "table-vgroup")) return nodes;
  return [...nodes.filter((node) => node.type === "table-vgroup"), ...nodes.filter((node) => node.type !== "table-vgroup")];
}

export function sortSidebarTreeChildrenForParent(parent: Pick<TreeNode, "type">, children: readonly TreeNode[], databaseType?: DatabaseType): TreeNode[] {
  return hoistTableVGroupChildren(orderSidebarTreeChildrenForParent(parent, children, databaseType));
}

/**
 * Orders a container whose rows are merged from paged metadata: only the flat
 * rows are sorted by label, while projected virtual table groups keep the
 * position (and relative order) the layout projection gave them. Sorting the
 * groups by name would move them out of the top slot they were projected into
 * (issues #9644 / #9653).
 */
export function sortSidebarTreeChildrenByNameKeepingTableVGroups(parent: Pick<TreeNode, "type">, children: readonly TreeNode[], databaseType?: DatabaseType): TreeNode[] {
  const groups = children.filter((node) => node.type === "table-vgroup");
  const flat = children.filter((node) => node.type !== "table-vgroup");
  const orderedFlat = [...flat].sort((left, right) => sidebarTreeCollator.compare(left.label, right.label));
  return sortSidebarTreeChildrenForParent(parent, [...groups, ...orderedFlat], databaseType);
}

function orderSidebarTreeChildrenForParent(parent: Pick<TreeNode, "type">, children: readonly TreeNode[], databaseType?: DatabaseType): TreeNode[] {
  const normalized = children.map((child) => sortRecursive(child, databaseType));

  if (parent.type === "mongo-db") {
    const gridFsNodes = normalized.filter((child) => child.type === "mongo-gridfs");
    const collections = normalized.filter((child) => child.type !== "mongo-gridfs");
    return [...gridFsNodes, ...sortByLabel(collections)];
  }

  if (parent.type === "vector-database") {
    return sortByLabel(normalized);
  }

  if (parent.type === "mongo-buckets") {
    return sortByLabel(normalized);
  }

  if (parent.type === "connection") {
    const savedSqlNodes = normalized.filter((child) => child.type === "saved-sql-root");
    const userAdminNodes = normalized.filter((child) => child.type === "user-admin" || child.type === "dameng-users" || child.type === "dameng-roles");
    const regularChildren = normalized.filter((child) => child.type !== "user-admin" && child.type !== "dameng-users" && child.type !== "dameng-roles" && child.type !== "saved-sql-root");
    const withConnectionUtilityOrder = (children: TreeNode[]) => [...savedSqlNodes, ...children, ...userAdminNodes];

    if (databaseType === "mongodb" || databaseType === "elasticsearch" || databaseType === "easysearch" || databaseType === "meilisearch" || databaseType === "solr" || databaseType === "qdrant" || databaseType === "milvus" || databaseType === "weaviate" || databaseType === "chromadb") {
      const meilisearchSystem = regularChildren.filter((child) => child.type === "meilisearch-system");
      const databaseObjects = regularChildren.filter((child) => child.type !== "meilisearch-system");
      return withConnectionUtilityOrder([...sortByLabel(databaseObjects), ...meilisearchSystem]);
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
