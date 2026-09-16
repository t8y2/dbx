import type { ColumnInfo, DatabaseType, TreeNode } from "@/types/database";
import { COLUMN_NAME_COPY_SEPARATOR_VALUES, type ColumnNameCopySeparator, isColumnNameCopySeparator } from "@/lib/dataGrid/dataGridColumnNameCopy";
import { copyNameForTreeNode } from "@/lib/sidebar/treeNodeClick";
import { qualifiedTableName } from "@/lib/table/tableSelectSql";

export type SidebarTableCopyTarget = TreeNode & { connectionId: string; database: string };

const TABLE_COPY_NODE_TYPES = new Set<TreeNode["type"]>(["table", "view", "materialized_view"]);

function isTableCopyTarget(node: TreeNode): node is SidebarTableCopyTarget {
  return TABLE_COPY_NODE_TYPES.has(node.type) && !!node.connectionId && !!node.database;
}

export function columnNameForSidebarDrag(node: TreeNode): string {
  if (node.type !== "column") return copyNameForTreeNode(node);
  const column = node.meta as Partial<ColumnInfo> | undefined;
  if (typeof column?.name === "string" && column.name) return column.name;
  return node.label.replace(/\s+\([^()]*\)$/, "");
}

function sameColumnTableContext(first: TreeNode, node: TreeNode): boolean {
  return node.type === "column" && !!node.connectionId && node.database != null && node.connectionId === first.connectionId && node.database === first.database && (node.schema ?? "") === (first.schema ?? "") && !!node.tableName && node.tableName === first.tableName;
}

export function resolveSidebarTableCopyTargets(activeNode: TreeNode, selectedNodes: readonly TreeNode[]): SidebarTableCopyTarget[] {
  if (!isTableCopyTarget(activeNode)) return [];
  if (selectedNodes.length <= 1 || !selectedNodes.some((node) => node.id === activeNode.id)) return [activeNode];
  const targets = selectedNodes.filter(isTableCopyTarget);
  if (targets.length <= 1) return [activeNode];
  const first = targets[0]!;
  if (!targets.every((node) => node.connectionId === first.connectionId && node.database === first.database && (node.catalog ?? "") === (first.catalog ?? ""))) {
    return [activeNode];
  }
  return targets;
}

export function resolveSidebarColumnDragTargets(activeNode: TreeNode, selectedNodes: readonly TreeNode[]): TreeNode[] {
  if (activeNode.type !== "column" || !activeNode.tableName) return [activeNode];
  if (selectedNodes.length <= 1 || !selectedNodes.some((node) => node.id === activeNode.id)) return [activeNode];
  const targets = selectedNodes.filter((node) => node.type === "column" && sameColumnTableContext(activeNode, node));
  return targets.length > 1 ? targets : [activeNode];
}

export function resolveSidebarColumnDragNames(activeNode: TreeNode, selectedNodes: readonly TreeNode[]): string[] {
  return resolveSidebarColumnDragTargets(activeNode, selectedNodes)
    .map(columnNameForSidebarDrag)
    .filter((name) => name.length > 0);
}

export interface FormatSidebarTableNamesOptions {
  separator: ColumnNameCopySeparator;
  includeSchema: boolean;
  databaseType?: DatabaseType;
  driverProfile?: string;
  identifierQuote?: string;
}

export function formatSidebarTableNamesForCopy(targets: readonly SidebarTableCopyTarget[], options: FormatSidebarTableNamesOptions): string {
  const separator = COLUMN_NAME_COPY_SEPARATOR_VALUES[options.separator] ?? ",";
  const parts = targets.map((target) => {
    if (!options.includeSchema) return copyNameForTreeNode(target);
    return qualifiedTableName({
      databaseType: options.databaseType,
      driverProfile: options.driverProfile,
      identifierQuote: options.identifierQuote,
      schema: target.schema,
      tableName: target.label,
      database: target.database,
      catalog: target.catalog,
    });
  });
  return parts.join(separator);
}

export function normalizeSidebarCopyTableNameSeparator(value: unknown): ColumnNameCopySeparator {
  return isColumnNameCopySeparator(value) ? value : "comma";
}

export function sidebarTableCopyNodes(activeNode: TreeNode, selectedNodes: readonly TreeNode[]): TreeNode[] {
  return selectedNodes.length > 1 && selectedNodes.some((node) => node.id === activeNode.id) ? [...selectedNodes] : [activeNode];
}

export function formatSidebarTableCopyText(activeNode: TreeNode, selectedNodes: readonly TreeNode[], options: FormatSidebarTableNamesOptions): string {
  const tableTargets = resolveSidebarTableCopyTargets(activeNode, selectedNodes);
  const separator = COLUMN_NAME_COPY_SEPARATOR_VALUES[options.separator] ?? ",";
  if (tableTargets.length > 0 && (tableTargets.length > 1 || options.includeSchema)) {
    return formatSidebarTableNamesForCopy(tableTargets, options);
  }
  return sidebarTableCopyNodes(activeNode, selectedNodes).map(copyNameForTreeNode).join(separator);
}
