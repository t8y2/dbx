import type { ConnectionConfig, SidebarOrderEntry, TreeNode } from "@/types/database";

export type ConnectionListSortMode = "manual" | "asc" | "desc";

const connectionNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Shared name comparator so every display-only surface sorts identically. */
export function compareConnectionListNames(left: string, right: string): number {
  return connectionNameCollator.compare(left, right);
}

function sortConnectionSiblingsForDisplay(nodes: readonly TreeNode[], mode: Exclude<ConnectionListSortMode, "manual">): TreeNode[] {
  const sortedConnections = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.type === "connection")
    .sort((left, right) => {
      const compared = compareConnectionListNames(left.node.label, right.node.label);
      const directional = mode === "asc" ? compared : -compared;
      return directional || left.index - right.index;
    })
    .map(({ node }) => node);

  const sortedGroups = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.type === "connection-group")
    .sort((left, right) => {
      const compared = compareConnectionListNames(left.node.label, right.node.label);
      const directional = mode === "asc" ? compared : -compared;
      return directional || left.index - right.index;
    })
    .map(({ node }) => {
      if (!node.children) return node;
      const children = sortConnectionSiblingsForDisplay(node.children, mode);
      return children === node.children ? node : { ...node, children };
    });

  let nextConnectionIndex = 0;
  let nextGroupIndex = 0;
  const displayNodes = nodes.map((node) => {
    if (node.type === "connection") {
      return sortedConnections[nextConnectionIndex++]!;
    }

    if (node.type === "connection-group") {
      return sortedGroups[nextGroupIndex++]!;
    }

    return node;
  });

  return displayNodes.every((node, index) => node === nodes[index]) ? (nodes as TreeNode[]) : displayNodes;
}

/**
 * Produces a display-only ordering of saved connections. In asc/desc modes
 * both connections and groups are ordered by name; the persisted manual
 * layout remains untouched, so switching back to manual order restores
 * drag-and-drop placement without a data migration.
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

/**
 * Mirror of the TreeNode sibling sort above, operating on the persisted
 * `SidebarLayout.order` entries. Connections and groups are each sorted by name
 * while the original group/connection slot interleaving is preserved, so any
 * surface that renders the sidebar order (e.g. the config export dialog) can
 * follow the same `asc`/`desc` display mode. Pure: never mutates `entries`.
 */
export function sortSidebarOrderEntriesForDisplay(entries: readonly SidebarOrderEntry[], mode: ConnectionListSortMode, groupNameOf: (id: string) => string | undefined, connectionNameOf: (id: string) => string | undefined): SidebarOrderEntry[] {
  if (mode === "manual") return entries as SidebarOrderEntry[];
  return sortSidebarOrderSiblings(entries, mode, groupNameOf, connectionNameOf);
}

function sortSidebarOrderSiblings(entries: readonly SidebarOrderEntry[], mode: Exclude<ConnectionListSortMode, "manual">, groupNameOf: (id: string) => string | undefined, connectionNameOf: (id: string) => string | undefined): SidebarOrderEntry[] {
  const compareByDirection = (left: string, right: string) => {
    const compared = compareConnectionListNames(left, right);
    return mode === "asc" ? compared : -compared;
  };

  const sortedConnections = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.type === "connection")
    .sort((left, right) => {
      // Unresolved/stale entries sort by their own id instead of an empty name,
      // otherwise they would all clump at the front in ascending mode.
      const leftName = connectionNameOf(left.entry.id) ?? left.entry.id;
      const rightName = connectionNameOf(right.entry.id) ?? right.entry.id;
      return compareByDirection(leftName, rightName) || left.index - right.index;
    })
    .map(({ entry }) => entry);

  const sortedGroups = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.type === "group")
    .sort((left, right) => {
      const leftName = groupNameOf(left.entry.id) ?? left.entry.id;
      const rightName = groupNameOf(right.entry.id) ?? right.entry.id;
      return compareByDirection(leftName, rightName) || left.index - right.index;
    })
    .map(({ entry }) => sortGroupEntryChildren(entry as Extract<SidebarOrderEntry, { type: "group" }>, mode, groupNameOf, connectionNameOf));

  let nextConnectionIndex = 0;
  let nextGroupIndex = 0;
  const displayEntries: SidebarOrderEntry[] = entries.map((entry) => {
    if (entry.type === "connection") return sortedConnections[nextConnectionIndex++]!;
    if (entry.type === "group") return sortedGroups[nextGroupIndex++]!;
    return entry;
  });

  return displayEntries.every((entry, index) => entry === entries[index]) ? (entries as SidebarOrderEntry[]) : displayEntries;
}

function sortGroupEntryChildren(entry: Extract<SidebarOrderEntry, { type: "group" }>, mode: Exclude<ConnectionListSortMode, "manual">, groupNameOf: (id: string) => string | undefined, connectionNameOf: (id: string) => string | undefined): SidebarOrderEntry {
  const children = entry.children ? sortSidebarOrderSiblings(entry.children, mode, groupNameOf, connectionNameOf) : undefined;
  // Legacy shape stores connection ids only; nested groups are not expressible there.
  const connectionIds = entry.connectionIds
    ? entry.connectionIds
        .map((id, index) => ({ id, index }))
        .sort((left, right) => {
          const compared = compareConnectionListNames(connectionNameOf(left.id) ?? left.id, connectionNameOf(right.id) ?? right.id);
          const directional = mode === "asc" ? compared : -compared;
          return directional || left.index - right.index;
        })
        .map(({ id }) => id)
    : undefined;

  const childrenChanged = children !== undefined && children !== entry.children;
  const idsChanged = connectionIds !== undefined && connectionIds.some((id, index) => id !== entry.connectionIds?.[index]);
  if (!childrenChanged && !idsChanged) return entry;

  // Spread keeps any fields a newer layout version added to the group entry.
  const next = { ...entry };
  if (children !== undefined) next.children = children;
  if (connectionIds !== undefined) next.connectionIds = connectionIds;
  return next;
}
