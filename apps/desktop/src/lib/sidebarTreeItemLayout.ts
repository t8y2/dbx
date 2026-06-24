import type { TreeNodeType } from "@/types/database";

const leafTypes: Set<TreeNodeType> = new Set(["column", "index", "fkey", "trigger", "procedure", "function", "package", "package-body", "object-browser", "redis-db", "mq-tenant", "zookeeper-root", "vector-collection", "elasticsearch-index", "user-admin", "saved-sql-file", "load-more"]);

const fullWidthLabelTypes: Set<TreeNodeType> = new Set(["table", "view", "materialized_view", "mongo-collection", "vector-collection", "elasticsearch-index"]);

const emptyContainerTypes: Set<TreeNodeType> = new Set(["saved-sql-root", "saved-sql-folder"]);

export function treeItemPaddingLeft(depth: number): string {
  return `${depth * 16 + 8}px`;
}

export function usesFullWidthTreeLabel(type: TreeNodeType, allowHorizontalScroll: boolean): boolean {
  return allowHorizontalScroll && fullWidthLabelTypes.has(type);
}

export function canTreeNodeExpand(type: TreeNodeType): boolean {
  return !leafTypes.has(type);
}

export function canTreeNodeShowExpander({ type, childCount }: { type: TreeNodeType; childCount?: number }): boolean {
  if (!canTreeNodeExpand(type)) return false;
  if (childCount === 0 && emptyContainerTypes.has(type)) return false;
  return true;
}
