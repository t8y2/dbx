import type { TreeNode, TreeNodeType } from "@/types/database";

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
  "extension",
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

const commentTypes: Set<TreeNodeType> = new Set(["schema", "table", "view", "materialized_view", "column", "mongo-collection", "vector-collection", "elasticsearch-index"]);

export function treeItemPaddingLeft(depth: number): string {
  return `${depth * 16 + 8}px`;
}

export const trailingCommentGapPx = 8;

export function trailingCommentAvailableWidth(containerWidth: number, leadingWidth: number): number {
  return Math.max(0, Math.floor(containerWidth - leadingWidth - trailingCommentGapPx));
}

export interface SidebarCommentAlignmentItem {
  id: string;
  depth: number;
  alignable: boolean;
  hasComment: boolean;
  labelWidth: number;
}

export function alignedSidebarCommentLabelWidths(items: readonly SidebarCommentAlignmentItem[]): Map<string, number> {
  const ancestorIds: string[] = [];
  const parentIdByCommentId = new Map<string, string>();
  const maxWidthByParentId = new Map<string, number>();

  for (const item of items) {
    ancestorIds.length = item.depth;
    const parentId = item.depth > 0 ? (ancestorIds[item.depth - 1] ?? "__root__") : "__root__";
    ancestorIds[item.depth] = item.id;
    if (!item.alignable) continue;

    maxWidthByParentId.set(parentId, Math.max(maxWidthByParentId.get(parentId) ?? 0, Math.ceil(item.labelWidth)));
    if (item.hasComment) parentIdByCommentId.set(item.id, parentId);
  }

  const widths = new Map<string, number>();
  for (const [id, parentId] of parentIdByCommentId) {
    widths.set(id, maxWidthByParentId.get(parentId) ?? 0);
  }
  return widths;
}

export function sidebarTreeNodeComment(node: TreeNode): string | null {
  if (!commentTypes.has(node.type)) return null;
  if (node.type === "column" && node.meta && "comment" in node.meta) {
    const comment = node.meta.comment;
    return typeof comment === "string" && comment ? comment : null;
  }
  return node.comment || null;
}

export function isSidebarCommentAlignableNode(node: TreeNode): boolean {
  return commentTypes.has(node.type);
}

export function usesFullWidthTreeLabel(type: TreeNodeType, allowHorizontalScroll: boolean, hasTrailingComment = false): boolean {
  return allowHorizontalScroll && !hasTrailingComment && fullWidthLabelTypes.has(type);
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
