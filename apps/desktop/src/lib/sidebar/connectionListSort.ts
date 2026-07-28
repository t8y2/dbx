import type { TreeNode } from "@/types/database";

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
