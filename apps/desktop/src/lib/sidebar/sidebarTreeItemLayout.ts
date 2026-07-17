import type { TreeNodeType } from "@/types/database";

const leafTypes: Set<TreeNodeType> = new Set([
  "column",
  "index",
  "fkey",
  "trigger",
  "procedure",
  "function",
  "package",
  "package-body",
  "type",
  "type-body",
  "object-browser",
  "redis-db",
  "mq-tenant",
  "zookeeper-root",
  "mongo-gridfs",
  "mongo-bucket",
  "vector-collection",
  "elasticsearch-index",
  "user-admin",
  "saved-sql-file",
  "table-search-control",
  "load-more",
]);

const fullWidthLabelTypes: Set<TreeNodeType> = new Set(["table", "view", "materialized_view", "mongo-collection", "mongo-bucket", "vector-collection", "elasticsearch-index"]);

const emptyContainerTypes: Set<TreeNodeType> = new Set(["saved-sql-root", "saved-sql-folder"]);

const pinnableTypes: Set<TreeNodeType> = new Set([
  "connection-group",
  "database",
  "linked-server",
  "linked-server-catalog",
  "linked-server-schema",
  "doris-catalog",
  "schema",
  "table",
  "view",
  "materialized_view",
  "redis-db",
  "mongo-db",
  "mongo-gridfs",
  "mongo-bucket",
  "mongo-collection",
  "vector-collection",
  "elasticsearch-index",
  "nacos-namespace",
]);

export function treeItemPaddingLeft(depth: number): string {
  return `${depth * 16 + 8}px`;
}

export function usesFullWidthTreeLabel(type: TreeNodeType, allowHorizontalScroll: boolean): boolean {
  return allowHorizontalScroll && fullWidthLabelTypes.has(type);
}

export function treeLabelWidthClass({ fullWidth, hasTrailingComment }: { fullWidth: boolean; hasTrailingComment: boolean }): string {
  if (fullWidth) return "shrink-0 whitespace-nowrap";
  return hasTrailingComment ? "min-w-0 flex-1 truncate" : "min-w-0 truncate";
}

export function canTreeNodeExpand(type: TreeNodeType): boolean {
  return !leafTypes.has(type);
}

export function canTreeNodeShowExpander({ type, childCount }: { type: TreeNodeType; childCount?: number }): boolean {
  if (!canTreeNodeExpand(type)) return false;
  if (childCount === 0 && emptyContainerTypes.has(type)) return false;
  return true;
}

export function canTreeNodePin(type: TreeNodeType): boolean {
  return pinnableTypes.has(type);
}
