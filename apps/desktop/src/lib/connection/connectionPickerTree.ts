import type { SidebarLayout, SidebarOrderEntry } from "@/types/database";

export interface ConnectionPickerConnection {
  id: string;
  name: string;
}

export interface ConnectionPickerRow {
  /** Stable key for list rendering. */
  key: string;
  kind: "group" | "connection";
  id: string;
  label: string;
  /** Nesting depth used for indentation; top-level entries are 0. */
  depth: number;
  /** Only meaningful for group rows: whether the group is currently collapsed. */
  collapsed: boolean;
}

function groupEntryChildren(entry: Extract<SidebarOrderEntry, { type: "group" }>): SidebarOrderEntry[] {
  return entry.children ?? entry.connectionIds?.map((id) => ({ type: "connection" as const, id })) ?? [];
}

function collectLayoutConnectionIds(entries: SidebarOrderEntry[], into: Set<string>) {
  for (const entry of entries) {
    if (entry.type === "connection") {
      into.add(entry.id);
    } else {
      collectLayoutConnectionIds(groupEntryChildren(entry), into);
    }
  }
}

function connectionMatchesQuery(name: string, groupPath: string[], normalizedQuery: string): boolean {
  if (name.toLowerCase().includes(normalizedQuery)) return true;
  return groupPath.join(" / ").toLowerCase().includes(normalizedQuery);
}

/**
 * Flattens the sidebar layout into renderable rows for the toolbar connection
 * picker. Groups are shown as non-selectable rows that mirror the sidebar tree;
 * connections missing from the layout are appended at the top level so they
 * stay reachable. With a search query the tree is fully expanded and only
 * connections matching by name or group path (plus their ancestor groups) are
 * kept.
 */
export function buildConnectionPickerRows(layout: SidebarLayout, connections: readonly ConnectionPickerConnection[], collapsedGroupIds: ReadonlySet<string>, searchQuery: string): ConnectionPickerRow[] {
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  const groupById = new Map(layout.groups.map((group) => [group.id, group]));
  const normalizedQuery = searchQuery.trim().toLowerCase();

  if (normalizedQuery) {
    const rows: ConnectionPickerRow[] = [];
    const visitSearch = (entries: SidebarOrderEntry[], depth: number, groupPath: string[]): ConnectionPickerRow[] => {
      const result: ConnectionPickerRow[] = [];
      for (const entry of entries) {
        if (entry.type === "connection") {
          const connection = connectionById.get(entry.id);
          if (!connection) continue;
          const label = connection.name || connection.id;
          if (connectionMatchesQuery(label, groupPath, normalizedQuery)) {
            result.push({ key: `connection:${connection.id}`, kind: "connection", id: connection.id, label, depth, collapsed: false });
          }
          continue;
        }
        const group = groupById.get(entry.id);
        if (!group) continue;
        const childRows = visitSearch(groupEntryChildren(entry), depth + 1, [...groupPath, group.name]);
        if (childRows.length === 0) continue;
        result.push({ key: `group:${group.id}`, kind: "group", id: group.id, label: group.name, depth, collapsed: false }, ...childRows);
      }
      return result;
    };
    rows.push(...visitSearch(layout.order, 0, []));

    const layoutConnectionIds = new Set<string>();
    collectLayoutConnectionIds(layout.order, layoutConnectionIds);
    for (const connection of connections) {
      if (layoutConnectionIds.has(connection.id)) continue;
      const label = connection.name || connection.id;
      if (connectionMatchesQuery(label, [], normalizedQuery)) {
        rows.push({ key: `connection:${connection.id}`, kind: "connection", id: connection.id, label, depth: 0, collapsed: false });
      }
    }
    return rows;
  }

  const rows: ConnectionPickerRow[] = [];
  const visitTree = (entries: SidebarOrderEntry[], depth: number) => {
    for (const entry of entries) {
      if (entry.type === "connection") {
        const connection = connectionById.get(entry.id);
        if (!connection) continue;
        rows.push({ key: `connection:${connection.id}`, kind: "connection", id: connection.id, label: connection.name || connection.id, depth, collapsed: false });
        continue;
      }
      const group = groupById.get(entry.id);
      if (!group) continue;
      const collapsed = collapsedGroupIds.has(group.id);
      rows.push({ key: `group:${group.id}`, kind: "group", id: group.id, label: group.name, depth, collapsed });
      if (!collapsed) visitTree(groupEntryChildren(entry), depth + 1);
    }
  };
  visitTree(layout.order, 0);

  const layoutConnectionIds = new Set<string>();
  collectLayoutConnectionIds(layout.order, layoutConnectionIds);
  for (const connection of connections) {
    if (layoutConnectionIds.has(connection.id)) continue;
    rows.push({ key: `connection:${connection.id}`, kind: "connection", id: connection.id, label: connection.name || connection.id, depth: 0, collapsed: false });
  }
  return rows;
}

/** Selectable rows in display order, used for keyboard navigation. */
export function connectionPickerSelectableRows(rows: readonly ConnectionPickerRow[]): ConnectionPickerRow[] {
  return rows.filter((row) => row.kind === "connection");
}
