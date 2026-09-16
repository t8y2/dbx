import type { TreeNode } from "@/types/database";

/**
 * 侧边栏中支持“查看 DDL”的节点类型，与右键菜单的
 * “查看 DDL”菜单项可见条件保持一致。
 */
export function sidebarNodeSupportsDdlView(node: TreeNode): boolean {
  return node.type === "table" || node.type === "view" || node.type === "materialized_view";
}
