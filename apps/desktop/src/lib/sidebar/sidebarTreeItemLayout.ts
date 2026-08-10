import type { TreeNode, TreeNodeType } from "@/types/database";

const leafTypes: Set<TreeNodeType> = new Set([
  "column",
  "index",
  "fkey",
  "trigger",
  "procedure",
  "function",
  "synonym",
  "package",
  "package-body",
  "type",
  "type-body",
  "object-browser",
  "redis-db",
  "mq-tenant",
  "etcd-root",
  "etcd-dashboard",
  "etcd-access-control",
  "zookeeper-root",
  "consul-root",
  "consul-overview",
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

const commentTypes: Set<TreeNodeType> = new Set(["connection", "schema", "table", "view", "materialized_view", "column", "mongo-collection", "vector-collection", "elasticsearch-index"]);

export function treeItemPaddingLeft(depth: number): string {
  return `${depth * 16 + 8}px`;
}

export const trailingCommentGapPx = 8;
export const sidebarPinnedActionSlotWidthPx = 24;

export function trailingCommentAvailableWidth(containerWidth: number, leadingWidth: number): number {
  return Math.max(0, Math.floor(containerWidth - leadingWidth - trailingCommentGapPx));
}

export function alignedCommentLeadingWidth(labelWidth: number | undefined, reservePinnedAction: boolean): number | undefined {
  if (labelWidth === undefined) return undefined;
  return labelWidth + (reservePinnedAction ? sidebarPinnedActionSlotWidthPx : 0);
}

export interface SidebarCommentAlignmentItem {
  id: string;
  depth: number;
  alignable: boolean;
  hasComment: boolean;
  labelWidth: number;
}

export interface SidebarTreeNaturalWidthItem {
  depth: number;
  label: string;
  usesNaturalWidth: boolean;
  trailingWidth?: number;
}

// Right padding, expander/icon widths and the two flex gaps before the label.
const sidebarTreeRowChromeWidth = 54;

export function sidebarTreeNaturalContentWidth(items: readonly SidebarTreeNaturalWidthItem[], measureText: (text: string) => number): number {
  let width = 0;
  for (const item of items) {
    if (!item.usesNaturalWidth) continue;
    const paddingLeft = item.depth * 16 + 8;
    width = Math.max(width, Math.ceil(paddingLeft + sidebarTreeRowChromeWidth + measureText(item.label) + (item.trailingWidth ?? 0)));
  }
  return width;
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

export function treeLabelWidthClass({ fullWidth, hasTrailingComment, hasInlineAction = false, alignLeading = false }: { fullWidth: boolean; hasTrailingComment: boolean; hasInlineAction?: boolean; alignLeading?: boolean }): string {
  if (fullWidth) return "shrink-0 whitespace-nowrap";
  if (hasTrailingComment && hasInlineAction) return "min-w-0 shrink truncate";
  // aligned 模式靠 leading 块固定宽度对齐 comment 列，label 需 flex-1 撑满 leading 块；
  // inline/right 模式 label 用 shrink 让 comment 紧跟，避免 label 撑满把 comment 推到最右。
  if (hasTrailingComment) return alignLeading ? "min-w-0 flex-1 truncate" : "min-w-0 shrink truncate";
  return "min-w-0 truncate";
}

export function canTreeNodeExpand(type: TreeNodeType): boolean {
  return !leafTypes.has(type);
}

export function canTreeNodeShowExpander({ type, childCount, explicitContainer = false }: { type: TreeNodeType; childCount?: number; explicitContainer?: boolean }): boolean {
  if (!canTreeNodeExpand(type) && !((type === "package" || type === "type") && explicitContainer)) return false;
  if (childCount === 0 && emptyContainerTypes.has(type)) return false;
  return true;
}

export function canTreeNodePin(type: TreeNodeType): boolean {
  return pinnableTypes.has(type);
}
