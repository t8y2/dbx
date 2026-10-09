import type { ConnectionConfig, TreeNode } from "@/types/database";

export type ConnectionListSortMode = "manual" | "asc" | "desc";

const connectionNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function sortConnectionSiblingsForDisplay(nodes: readonly TreeNode[], mode: Exclude<ConnectionListSortMode, "manual">): TreeNode[] {
  const sortedConnections = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.type === "connection")
    .sort((left, right) => {
      const compared = connectionNameCollator.compare(left.node.label, right.node.label);
      const directional = mode === "asc" ? compared : -compared;
      return directional || left.index - right.index;
    })
    .map(({ node }) => node);

  let nextConnectionIndex = 0;
  const displayNodes = nodes.map((node) => {
    if (node.type === "connection") {
      return sortedConnections[nextConnectionIndex++]!;
    }

    if (node.type !== "connection-group" || !node.children) return node;
    const children = sortConnectionSiblingsForDisplay(node.children, mode);
    return children === node.children ? node : { ...node, children };
  });

  return displayNodes.every((node, index) => node === nodes[index]) ? (nodes as TreeNode[]) : displayNodes;
}

/**
 * Produces a display-only ordering of saved connections. Group positions and
 * the persisted manual layout remain untouched, so switching back to manual
 * order restores drag-and-drop placement without a data migration.
 */
export function sortConnectionListForDisplay(nodes: readonly TreeNode[], mode: ConnectionListSortMode): TreeNode[] {
  if (mode === "manual") return nodes as TreeNode[];
  return sortConnectionSiblingsForDisplay(nodes, mode);
}

/**
 * Projects connection configs into the order shown by the sidebar. Connections
 * missing from the current tree are appended in store order so a stale layout
 * or newly added connection cannot make them unavailable to other surfaces.
 */
export function orderConnectionsForSidebarDisplay<T extends Pick<ConnectionConfig, "id">>(connections: readonly T[], nodes: readonly TreeNode[], mode: ConnectionListSortMode): T[] {
  const connectionsById = new Map<string, T>();
  for (const connection of connections) {
    if (!connectionsById.has(connection.id)) connectionsById.set(connection.id, connection);
  }

  const ordered: T[] = [];
  const seen = new Set<string>();
  const appendConnection = (id: string) => {
    const connection = connectionsById.get(id);
    if (!connection || seen.has(id)) return;
    seen.add(id);
    ordered.push(connection);
  };
  const visit = (treeNodes: readonly TreeNode[]) => {
    for (const node of treeNodes) {
      if (node.type === "connection") appendConnection(node.connectionId ?? node.id);
      else if (node.type === "connection-group" && node.children) visit(node.children);
    }
  };

  visit(sortConnectionListForDisplay(nodes, mode));
  for (const connection of connections) appendConnection(connection.id);
  return ordered;
}
