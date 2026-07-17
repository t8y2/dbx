import type { TreeNode } from "@/types/database";

export interface SidebarDatabaseExportSource {
  connectionId: string;
  database: string;
  schema?: string;
  tableName?: string;
  tableNames?: string[];
  allDatabases?: boolean;
}

export function databaseExportSourceForNode(node: TreeNode): SidebarDatabaseExportSource | null {
  if (!node.connectionId || !node.database) return null;
  const objectNode = node.type === "table" || node.type === "view" || node.type === "materialized_view";
  return {
    connectionId: node.connectionId,
    database: node.database,
    schema: node.type === "schema" || objectNode ? node.schema : undefined,
    tableName: objectNode ? node.label : undefined,
  };
}

export function allDatabasesExportSourceForNode(node: TreeNode): SidebarDatabaseExportSource | null {
  if (node.type !== "connection" || !node.connectionId) return null;
  return { connectionId: node.connectionId, database: "", allDatabases: true };
}

export function sidebarStructureExportTargets(activeNode: TreeNode, treeNodes: readonly TreeNode[], selectedNodeIds: readonly string[]): Array<TreeNode & { connectionId: string; database: string }> {
  const canExport = (node: TreeNode): node is TreeNode & { connectionId: string; database: string } => (node.type === "table" || node.type === "view" || node.type === "materialized_view") && !!node.connectionId && !!node.database;
  if (!canExport(activeNode)) return [];

  const selected = new Set(selectedNodeIds);
  const targets: Array<TreeNode & { connectionId: string; database: string }> = [];
  const visit = (nodes: readonly TreeNode[]) => {
    for (const node of nodes) {
      if (selected.has(node.id) && canExport(node)) targets.push(node);
      if (node.children) visit(node.children);
      if (node.hiddenChildren) visit(node.hiddenChildren);
    }
  };
  visit(treeNodes);
  return targets.length > 1 && targets.some((node) => node.id === activeNode.id) ? targets : [activeNode];
}
