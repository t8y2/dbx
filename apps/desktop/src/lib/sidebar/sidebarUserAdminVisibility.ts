import type { TreeNode } from "@/types/database";

export function sidebarUserAdminVisibility(nodes: TreeNode[], showUserAdmin: boolean): { nodes: TreeNode[]; hiddenNodeIds: ReadonlySet<string> } {
  const hiddenNodeIds = new Set<string>();
  if (showUserAdmin) return { nodes, hiddenNodeIds };

  function filterNodes(source: TreeNode[]): TreeNode[] {
    let changed = false;
    const visible: TreeNode[] = [];
    for (const node of source) {
      if (node.type === "user-admin" || node.type === "xugu-user-admin") {
        hiddenNodeIds.add(node.id);
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
