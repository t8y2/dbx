import type { PluginTableContext, TreeNode } from "@/types/database";

export type PluginTableContextNode = Pick<TreeNode, "type" | "connectionId" | "database" | "schema" | "tableName">;

export interface PluginContextMenuInvocation {
  method: string;
  params: {
    table: PluginTableContext;
  };
}

function nonEmptyContextValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

/**
 * Builds the public table identity from the sidebar node's canonical metadata.
 * Display labels are deliberately not part of this input or its fallback path.
 */
export function buildPluginTableContext(node: PluginTableContextNode): PluginTableContext | null {
  if (node.type !== "table") return null;

  const connectionId = nonEmptyContextValue(node.connectionId);
  const table = nonEmptyContextValue(node.tableName);
  if (!connectionId || !table) return null;

  const context: PluginTableContext = { connectionId, table };
  const database = nonEmptyContextValue(node.database);
  const schema = nonEmptyContextValue(node.schema);
  if (database !== undefined) context.database = database;
  if (schema !== undefined) context.schema = schema;
  return context;
}

export function buildPluginTableContextMenuInvocation(contributionId: string, node: PluginTableContextNode): PluginContextMenuInvocation | null {
  if (!contributionId.trim()) return null;
  const table = buildPluginTableContext(node);
  if (!table) return null;
  return {
    method: `contextMenu/${contributionId}`,
    params: { table },
  };
}
