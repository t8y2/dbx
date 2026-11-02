import type { ConnectionConfig, PluginContextMenuContribution, PluginTableContext, TreeNode } from "@/types/database";
import type { PluginWorkbenchContext } from "./pluginHostBridge";

export type PluginTableContextNode = Pick<TreeNode, "type" | "connectionId" | "database" | "schema" | "tableName">;

interface PluginContextMenuConnectionContext {
  id: string;
  dbType: string;
  name: string;
  database: string;
}

type PluginContextMenuBackendParams = { connection: PluginContextMenuConnectionContext } | { table: PluginTableContext };

export interface PluginContextMenuInvocation {
  method: string;
  params: PluginContextMenuBackendParams;
  /** Semantic invocation context passed directly to a declared plugin workbench. */
  context: PluginWorkbenchContext;
  /** Host-side tab identity; never copied from a plugin-controlled value. */
  connectionId: string;
}

export interface PluginContextMenuActivationHandlers {
  findWorkbench(pluginId: string, workbenchId: string): boolean;
  openWorkbench(pluginId: string, workbenchId: string, options: { title: string; connectionId: string; context: PluginWorkbenchContext; refreshContextOnReuse: true }): void;
  invokePlugin(pluginId: string, method: string, params: PluginContextMenuBackendParams): Promise<unknown>;
  toast(message: string, durationMs: number): void;
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
  const context = { ...table } satisfies PluginWorkbenchContext;
  return {
    method: `contextMenu/${contributionId}`,
    params: { table },
    context,
    connectionId: table.connectionId,
  };
}

/**
 * Keep the existing connection backend envelope while exposing only its
 * established non-secret summary as workbench context.
 */
export function buildPluginConnectionContextMenuInvocation(contributionId: string, connection: Pick<ConnectionConfig, "id" | "db_type" | "name" | "database">): PluginContextMenuInvocation | null {
  if (!contributionId.trim()) return null;
  const context = {
    id: connection.id,
    dbType: connection.db_type,
    name: connection.name,
    database: connection.database || "",
  } satisfies PluginWorkbenchContext;
  return {
    method: `contextMenu/${contributionId}`,
    params: { connection: context },
    context,
    connectionId: connection.id,
  };
}

/**
 * Declarative actions stay in the host: only legacy entries reach the plugin
 * backend, preserving the original message/error toast behavior.
 */
export function activatePluginContextMenuItem(pluginId: string, contribution: PluginContextMenuContribution, invocation: PluginContextMenuInvocation, handlers: PluginContextMenuActivationHandlers): Promise<void> | void {
  const action = contribution.action;
  if (action?.type === "open-workbench") {
    if (!handlers.findWorkbench(pluginId, action.workbench)) {
      handlers.toast(`Plugin workbench '${pluginId}/${action.workbench}' is unavailable`, 5000);
      return;
    }
    try {
      handlers.openWorkbench(pluginId, action.workbench, {
        title: contribution.label,
        connectionId: invocation.connectionId,
        context: invocation.context,
        refreshContextOnReuse: true,
      });
    } catch (error) {
      handlers.toast(String((error as Error)?.message || error), 5000);
    }
    return;
  }

  return handlers
    .invokePlugin(pluginId, invocation.method, invocation.params)
    .then((result) => {
      const message = (result as { message?: unknown } | null | undefined)?.message;
      if (typeof message === "string" && message.trim()) handlers.toast(message, 4000);
    })
    .catch((error: unknown) => {
      handlers.toast(String((error as Error)?.message || error), 5000);
    });
}
