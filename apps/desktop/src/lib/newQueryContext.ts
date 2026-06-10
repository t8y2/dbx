import { resolveDefaultDatabase } from "@/lib/defaultDatabase";
import type { ConnectionConfig, QueryTab, TreeNode } from "@/types/database";

export interface NewQueryTarget {
  connectionId: string;
  database: string;
  schema?: string;
  shouldRefreshDefaultDatabase: boolean;
}

export type NewQueryContextSource = "tab" | "sidebar";

interface ResolveNewQueryTargetInput {
  activeTab?: Pick<QueryTab, "connectionId" | "database" | "schema">;
  selectedTreeNode?: Pick<TreeNode, "connectionId" | "database" | "schema"> | null;
  activeConnectionId?: string | null;
  connections: Pick<ConnectionConfig, "id" | "database">[];
  preferredSource?: NewQueryContextSource;
}

export function findTreeNodeById(nodes: TreeNode[], id: string | null | undefined): TreeNode | null {
  if (!id) return null;
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findTreeNodeById(node.children || [], id);
    if (found) return found;
  }
  return null;
}

export function resolveNewQueryTarget(input: ResolveNewQueryTargetInput): NewQueryTarget | null {
  const primaryContext = input.preferredSource === "sidebar" ? input.selectedTreeNode || undefined : input.activeTab;
  const secondaryContext = input.preferredSource === "sidebar" ? input.activeTab : input.selectedTreeNode || undefined;
  const primaryTarget = targetFromContext(primaryContext, input.connections);
  if (primaryTarget) return primaryTarget;
  const secondaryTarget = targetFromContext(secondaryContext, input.connections);
  if (secondaryTarget) return secondaryTarget;

  const activeConnection = input.activeConnectionId ? input.connections.find((connection) => connection.id === input.activeConnectionId) : undefined;
  const fallbackConnection = activeConnection || input.connections[0];
  return fallbackConnection
    ? {
        connectionId: fallbackConnection.id,
        database: resolveDefaultDatabase(fallbackConnection, []),
        shouldRefreshDefaultDatabase: true,
      }
    : null;
}

function targetFromContext(context: Pick<QueryTab | TreeNode, "connectionId" | "database" | "schema"> | undefined, connections: Pick<ConnectionConfig, "id" | "database">[]): NewQueryTarget | null {
  if (!context?.connectionId) return null;
  const connection = connections.find((item) => item.id === context.connectionId);
  if (!connection) return null;
  const database = context.database || resolveDefaultDatabase(connection, []);
  return {
    connectionId: context.connectionId,
    database,
    schema: "schema" in context ? (context as { schema?: string }).schema : undefined,
    shouldRefreshDefaultDatabase: !context.database,
  };
}
