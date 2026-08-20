import type { ConnectionConfig, SidebarLayout, TunnelProfile } from "@/types/database";
import { filterSidebarLayoutByConnectionIds as filterLayoutByConnectionIds } from "@/lib/sidebar/sidebarLayout";

export interface ConnectionConfigBundle {
  connections: ConnectionConfig[];
  layout?: SidebarLayout;
  tunnelProfiles?: TunnelProfile[];
}

export interface ConnectionConfigSnapshotOptions {
  connectTimeoutSecs: (connection: ConnectionConfig) => number;
  queryTimeoutSecs: (connection: ConnectionConfig) => number;
}

export function selectedConnectionIdSet(connectionIds: Iterable<string> | undefined): Set<string> | undefined {
  if (connectionIds == null) return undefined;
  return new Set(Array.from(connectionIds).filter((id) => typeof id === "string" && id.length > 0));
}

export function filterConnectionsByIds(connections: ConnectionConfig[], selectedIds?: Iterable<string>): ConnectionConfig[] {
  const selected = selectedConnectionIdSet(selectedIds);
  if (!selected) return [...connections];
  return connections.filter((connection) => selected.has(connection.id));
}

export function filterSidebarLayoutByConnectionIds(layout: SidebarLayout | null | undefined, selectedIds: Iterable<string>): SidebarLayout {
  return filterLayoutByConnectionIds(layout, Array.from(selectedConnectionIdSet(selectedIds) ?? []));
}

export function referencedTunnelProfileIds(connections: Iterable<Pick<ConnectionConfig, "transport_layers">>): Set<string> {
  const ids = new Set<string>();
  for (const connection of connections) {
    for (const layer of connection.transport_layers ?? []) {
      if (typeof layer.profile_id === "string" && layer.profile_id) ids.add(layer.profile_id);
    }
  }
  return ids;
}

export function filterTunnelProfilesByIds(profiles: TunnelProfile[], selectedIds: Iterable<string>): TunnelProfile[] {
  const selected = selectedConnectionIdSet(selectedIds);
  if (!selected) return [...profiles];
  const seen = new Set<string>();
  const filtered: TunnelProfile[] = [];
  for (const profile of profiles) {
    if (!selected.has(profile.id) || seen.has(profile.id)) continue;
    seen.add(profile.id);
    filtered.push(profile);
  }
  return filtered;
}

export function snapshotConnectionsForExport(connections: ConnectionConfig[], options: ConnectionConfigSnapshotOptions): ConnectionConfig[] {
  return connections.map((connection) => ({
    ...connection,
    connect_timeout_secs: connection.connect_timeout_inherit === true ? options.connectTimeoutSecs(connection) : connection.connect_timeout_secs,
    query_timeout_secs: connection.query_timeout_inherit === true ? options.queryTimeoutSecs(connection) : connection.query_timeout_secs,
  }));
}

export function buildConnectionConfigBundle(connections: ConnectionConfig[], layout: SidebarLayout | null | undefined, tunnelProfiles: TunnelProfile[], selectedIds?: Iterable<string>): ConnectionConfigBundle {
  const selectedConnections = filterConnectionsByIds(connections, selectedIds);
  const selectedConnectionIds = selectedConnections.map((connection) => connection.id);
  return {
    connections: selectedConnections,
    layout: filterSidebarLayoutByConnectionIds(layout, selectedConnectionIds),
    tunnelProfiles: filterTunnelProfilesByIds(tunnelProfiles, referencedTunnelProfileIds(selectedConnections)),
  };
}

export function parseConnectionConfigObject(value: unknown): ConnectionConfigBundle {
  if (Array.isArray(value)) {
    return { connections: value as ConnectionConfig[] };
  }

  if (!value || typeof value !== "object") {
    return { connections: [] };
  }

  const parsed = value as {
    format?: unknown;
    connections?: unknown;
    layout?: SidebarLayout;
    tunnelProfiles?: unknown;
  };

  if (parsed.format === "dbx-config" && Array.isArray(parsed.connections)) {
    return { connections: parsed.connections as ConnectionConfig[] };
  }

  if (Array.isArray(parsed.connections)) {
    return {
      connections: parsed.connections as ConnectionConfig[],
      layout: parsed.layout?.groups && parsed.layout?.order ? parsed.layout : undefined,
      tunnelProfiles: Array.isArray(parsed.tunnelProfiles) ? (parsed.tunnelProfiles as TunnelProfile[]) : undefined,
    };
  }

  return { connections: [] };
}

export function selectConnectionConfigBundle(bundle: ConnectionConfigBundle, selectedIds?: Iterable<string>): ConnectionConfigBundle {
  const selectedConnections = filterConnectionsByIds(bundle.connections, selectedIds);
  const selectedConnectionIds = selectedConnections.map((connection) => connection.id);
  return {
    connections: selectedConnections,
    layout: bundle.layout ? filterSidebarLayoutByConnectionIds(bundle.layout, selectedConnectionIds) : undefined,
    tunnelProfiles: filterTunnelProfilesByIds(bundle.tunnelProfiles ?? [], referencedTunnelProfileIds(selectedConnections)),
  };
}
