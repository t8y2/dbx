import type { TreeNode } from "@/types/database";
import { sidebarDdlTargetsForExecutionContext } from "@/lib/sidebar/sidebarDdlTemplate";

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

export type SidebarStructureExportTarget = TreeNode & { connectionId: string; database: string };

function canStructureExport(node: TreeNode): node is SidebarStructureExportTarget {
  return (node.type === "table" || node.type === "view" || node.type === "materialized_view") && !!node.connectionId && !!node.database;
}

/** connection + database + catalog + schema identity for diagram and database-export prefills. */
export function sidebarStructureTargetSchemaContext(node: TreeNode): string {
  if (!node.connectionId || !node.database) return "";
  return `${node.connectionId}\0${node.database}\0${node.catalog ?? ""}\0${node.schema ?? ""}`;
}

export function sidebarStructureExportTargets(activeNode: TreeNode, treeNodes: readonly TreeNode[], selectedNodeIds: readonly string[]): SidebarStructureExportTarget[] {
  if (!canStructureExport(activeNode)) return [];

  const selected = new Set(selectedNodeIds);
  const targets: SidebarStructureExportTarget[] = [];
  const visit = (nodes: readonly TreeNode[]) => {
    for (const node of nodes) {
      if (selected.has(node.id) && canStructureExport(node)) targets.push(node);
      if (node.children) visit(node.children);
      if (node.hiddenChildren) visit(node.hiddenChildren);
    }
  };
  visit(treeNodes);
  return targets.length > 1 && targets.some((node) => node.id === activeNode.id) ? targets : [activeNode];
}

/** Keeps multi-select only when every target shares the active node's schema context. */
export function sidebarSameSchemaStructureTargets(activeNode: TreeNode, treeNodes: readonly TreeNode[], selectedNodeIds: readonly string[]): SidebarStructureExportTarget[] {
  if (!canStructureExport(activeNode)) return [];
  const targets = sidebarStructureExportTargets(activeNode, treeNodes, selectedNodeIds);
  if (targets.length <= 1) return targets;
  const activeContext = sidebarStructureTargetSchemaContext(activeNode);
  const sameContext = targets.filter((target) => sidebarStructureTargetSchemaContext(target) === activeContext);
  return sameContext.length > 1 && sameContext.some((target) => target.id === activeNode.id) ? sameContext : [activeNode];
}

/** Batch data export includes tables only and stays inside the active execution context; single-target fallback still allows one view/materialized view. */
export function sidebarTableDataExportTargets(activeNode: TreeNode, treeNodes: readonly TreeNode[], selectedNodeIds: readonly string[]): SidebarStructureExportTarget[] {
  const targets = canStructureExport(activeNode) ? sidebarDdlTargetsForExecutionContext(activeNode, sidebarStructureExportTargets(activeNode, treeNodes, selectedNodeIds)) : [];
  const tables = targets.filter((node) => node.type === "table");
  if (tables.length > 1 && tables.some((node) => node.id === activeNode.id)) return tables;
  if (activeNode.type === "table" && canStructureExport(activeNode)) return [activeNode];
  if (canStructureExport(activeNode) && targets.some((node) => node.id === activeNode.id)) return [activeNode];
  return tables;
}
