import type { ConnectionConfig, TreeNode } from "@/types/database";

const noHiddenNodeIds: ReadonlySet<string> = new Set();

function configHidesSidebarEntry(config: ConnectionConfig): boolean {
  return config.show_user_admin === false || config.show_database_links === false || config.show_native_jobs === false;
}

/**
 * `configs`, when given, lists every connection `getConfig` can resolve. If none of them hides an
 * entry the tree is returned as-is, so a sidebar with tens of thousands of table rows is not walked
 * (and every row is not tracked as a reactive dependency) on each page load.
 */
export function sidebarUserAdminVisibility(nodes: TreeNode[], getConfig?: (connectionId: string) => ConnectionConfig | undefined, configs?: readonly ConnectionConfig[]): { nodes: TreeNode[]; hiddenNodeIds: ReadonlySet<string> } {
  if (configs && !configs.some(configHidesSidebarEntry)) return { nodes, hiddenNodeIds: noHiddenNodeIds };
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
