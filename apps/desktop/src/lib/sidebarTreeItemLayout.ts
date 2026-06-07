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
  "object-browser",
  "redis-db",
  "mongo-collection",
  "saved-sql-file",
]);

const fullWidthLabelTypes: Set<TreeNodeType> = new Set(["table", "view", "mongo-collection"]);

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
  if (type === "saved-sql-root" || type === "saved-sql-folder") {
    return (childCount ?? 0) > 0;
  }
  return true;
}
