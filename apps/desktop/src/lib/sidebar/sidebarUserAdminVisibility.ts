import type { TreeNode, TreeNodeType } from "@/types/database";

const retiredToolTypes = new Set<TreeNodeType>(["connection-extensions", "user-admin", "xugu-user-admin", "dameng-users", "dameng-roles", "dameng-job-admin", "database-job-admin", "process-list", "server-dashboard", "saved-sql-root", "saved-sql-file", "saved-sql-folder"]);

export function sidebarObjectNavigationNodes(nodes: TreeNode[]): TreeNode[] {
  let changed = false;
  const visible: TreeNode[] = [];
  for (const node of nodes) {
    if (retiredToolTypes.has(node.type)) {
      changed = true;
      continue;
    }
    const children = node.children ? sidebarObjectNavigationNodes(node.children) : undefined;
    const hiddenChildren = node.hiddenChildren ? sidebarObjectNavigationNodes(node.hiddenChildren) : undefined;
    if (children !== node.children || hiddenChildren !== node.hiddenChildren) {
      visible.push({ ...node, children, hiddenChildren });
      changed = true;
    } else visible.push(node);
  }
  return changed ? visible : nodes;
}
