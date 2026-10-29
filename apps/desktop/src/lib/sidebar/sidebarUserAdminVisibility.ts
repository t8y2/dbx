import type { ConnectionConfig, TreeNode } from "@/types/database";

export function sidebarUserAdminVisibility(nodes: TreeNode[], getConfig?: (connectionId: string) => ConnectionConfig | undefined): { nodes: TreeNode[]; hiddenNodeIds: ReadonlySet<string> } {
  const hiddenNodeIds = new Set<string>();

  function hideNode(node: TreeNode) {
    hiddenNodeIds.add(node.id);
    node.children?.forEach(hideNode);
    node.hiddenChildren?.forEach(hideNode);
  }

  function filterNodes(source: TreeNode[]): TreeNode[] {
    let changed = false;
    const visible: TreeNode[] = [];
    for (const node of source) {
      const field = node.type === "user-admin" || node.type === "xugu-user-admin" ? "show_user_admin" : node.type === "oracle-db-links" ? "show_database_links" : node.type === "database-job-admin" || node.type === "dameng-job-admin" ? "show_native_jobs" : undefined;
      const config = field && node.connectionId ? getConfig?.(node.connectionId) : undefined;
      const visibleEntry = !field || config?.[field] !== false;
      if (!visibleEntry) {
        hideNode(node);
        changed = true;
        continue;
      }
      const children = node.children ? filterNodes(node.children) : undefined;
      const hiddenChildren = node.hiddenChildren ? filterNodes(node.hiddenChildren) : undefined;
      if (children !== node.children || hiddenChildren !== node.hiddenChildren) {
        visible.push({ ...node, children, hiddenChildren });
        changed = true;
      } else {
        visible.push(node);
      }
    }
    return changed ? visible : source;
  }

  // Preserve the live tree so showing the entries again requires no metadata reload.
  return { nodes: filterNodes(nodes), hiddenNodeIds };
}
