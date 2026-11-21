import type { DatabaseType, TreeNode } from "@/types/database";
import { isSqlServerLinkedNode } from "@/lib/database/sqlServerLinkedServers";
import { supportsTableStructureEditing } from "@/lib/database/databaseFeatureSupport";

/**
 * 侧边栏中支持“编辑表结构”的节点类型与条件，与右键菜单的
 * “编辑表结构”菜单项可见条件保持一致。
 */
export function sidebarNodeSupportsStructureEdit(node: TreeNode, dbType?: DatabaseType): boolean {
  const editableNode = node.type === "table" || ((node.type === "column" || node.type === "index") && !!node.tableName);
  return editableNode && !isSqlServerLinkedNode(node) && !!node.connectionId && !!node.database && supportsTableStructureEditing(dbType);
}
