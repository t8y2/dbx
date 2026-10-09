import type { ConnectionConfig, SidebarLayout, TunnelProfile } from "@/types/database";
import { filterSidebarLayoutByConnectionIds as filterLayoutByConnectionIds, remapSidebarLayoutConnectionIds } from "@/lib/sidebar/sidebarLayout";

export type ConnectionExportProtection = { mode: "encrypted"; passphrase: string } | { mode: "plaintext" };

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

/** Remove every credential-bearing field before creating a plaintext bundle. */
export function scrubConnectionForPlaintextExport(connection: ConnectionConfig): ConnectionConfig {
  const scrubbed: ConnectionConfig = JSON.parse(JSON.stringify(connection)) as ConnectionConfig;
  scrubbed.password = "";
  scrubbed.url_params = scrubUrlParams(scrubbed.url_params);
  scrubbed.init_script = undefined;
  scrubbed.connection_string = undefined;
  scrubbed.redis_sentinel_password = "";
  scrubbed.connection_secrets = {};
  scrubbed.transport_layers = (scrubbed.transport_layers ?? []).map((layer) => {
    const copy = { ...layer } as typeof layer;
    if (copy.type === "ssh") {
      copy.password = "";
      copy.key_passphrase = "";
    } else if (copy.type === "proxy") {
      copy.password = "";
    } else {
      copy.token = "";
    }
    return copy;
  });
  scrubbed.external_config = scrubExternalConfig(scrubbed.external_config);
  return scrubbed;
}

export function scrubTunnelProfileForPlaintextExport(profile: TunnelProfile): TunnelProfile {
  const scrubbed = { ...profile };
  if (scrubbed.type === "ssh") {
    scrubbed.password = "";
    scrubbed.key_passphrase = "";
  } else if (scrubbed.type === "proxy") {
    scrubbed.password = "";
  } else {
    scrubbed.token = "";
  }
  return scrubbed;
}

function scrubExternalConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubExternalConfig);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/password|passphrase|secret|token|api[_-]?key|clientsecret|accesstoken|privatekey/i.test(key)) {
      output[key] = typeof child === "string" ? "" : null;
    } else if (key === "auth" && child && typeof child === "object" && !Array.isArray(child) && (child as Record<string, unknown>).kind === "apiKey") {
      output[key] = { ...(scrubExternalConfig(child) as Record<string, unknown>), value: "" };
    } else {
      output[key] = scrubExternalConfig(child);
    }
  }
  return output;
}

function scrubUrlParams(value: string | undefined): string | undefined {
  if (typeof value !== "string") return value;
  return value
    .split("&")
    .map((part) => {
      const separator = part.indexOf("=");
      if (separator < 0) return part;
      const key = part.slice(0, separator);
      const normalized = key.trim().toLowerCase().replace(/[_-]/g, "");
      return /password|passphrase|secret|token|apikey|privatekey|clientsecret/.test(normalized) ? key + "=" : part;
    })
    .join("&");
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

/** Ordinary file imports deduplicate connections while keeping cloud sync's ID merge policy separate. */
export function prepareConnectionConfigImport(bundle: ConnectionConfigBundle, existingConnections: Iterable<Pick<ConnectionConfig, "id" | "name" | "host" | "port"> | string>, existingTunnelProfileIds: Iterable<string>, createId: () => string): ConnectionConfigBundle {
  const existingConnectionList = Array.from(existingConnections);
  const existingConnectionIds = new Set(existingConnectionList.map((connection) => (typeof connection === "string" ? connection : connection.id)));
  const existingByIdentity = new Map<string, string>();
  for (const connection of existingConnectionList) {
    if (typeof connection === "string") continue;
    existingByIdentity.set(connectionIdentity(connection), connection.id);
  }

  const sourceConnections = bundle.connections.map((connection, index) => ({
    ...connection,
    // Anonymous legacy entries need a stable key for layout/reference remapping.
    id: connection.id?.trim() || `__dbx_import_${index}`,
  }));
  const connectionIds = new Map<string, string>();
  const importedConnections: ConnectionConfig[] = [];
  const importedByIdentity = new Map<string, string>();
  const seenSourceIds = new Set<string>();
  const occupiedConnectionIds = new Set(existingConnectionIds);

  for (const source of sourceConnections) {
    if (seenSourceIds.has(source.id)) throw new Error("DUPLICATE_IMPORT_ID");
    seenSourceIds.add(source.id);

    const identity = connectionIdentity(source);
    const duplicateId = existingByIdentity.get(identity) ?? importedByIdentity.get(identity);
    if (duplicateId) {
      connectionIds.set(source.id, duplicateId);
      continue;
    }

    let targetId = createId();
    while (!targetId || occupiedConnectionIds.has(targetId)) targetId = createId();
    occupiedConnectionIds.add(targetId);
    connectionIds.set(source.id, targetId);
    importedByIdentity.set(identity, targetId);
    importedConnections.push({ ...source, id: targetId });
  }

  const sourceProfiles = new Map<string, TunnelProfile>();
  for (const profile of bundle.tunnelProfiles ?? []) {
    const id = profile.id?.trim();
    if (id && !sourceProfiles.has(id)) sourceProfiles.set(id, { ...profile, id });
  }
  const profileIds = new Map<string, string>();
  const importedTunnelProfileIds = new Set<string>();
  const occupiedProfileIds = new Set(existingTunnelProfileIds);
  for (const connection of importedConnections) {
    for (const layer of connection.transport_layers ?? []) {
      const sourceProfileId = layer.profile_id;
      if (!sourceProfileId || !sourceProfiles.has(sourceProfileId) || profileIds.has(sourceProfileId)) continue;
      let targetId = sourceProfileId;
      if (occupiedProfileIds.has(targetId)) {
        targetId = createId();
        while (!targetId || occupiedProfileIds.has(targetId)) targetId = createId();
      }
      occupiedProfileIds.add(targetId);
      profileIds.set(sourceProfileId, targetId);
      importedTunnelProfileIds.add(sourceProfileId);
    }
  }

  return {
    connections: importedConnections.map((connection) => ({
      ...connection,
      transport_layers: connection.transport_layers?.map((layer) => ({
        ...layer,
        // Never leave an unresolved source ID pointing at an unrelated local profile.
        profile_id: layer.profile_id ? profileIds.get(layer.profile_id) : undefined,
      })),
    })),
    tunnelProfiles: Array.from(importedTunnelProfileIds, (sourceId) => ({ ...sourceProfiles.get(sourceId)!, id: profileIds.get(sourceId)! })),
    layout: bundle.layout ? filterSidebarLayoutByConnectionIds(remapSidebarLayoutConnectionIds(bundle.layout, connectionIds), connectionIds.values()) : undefined,
  };
}

function connectionIdentity(connection: Pick<ConnectionConfig, "name" | "host" | "port">): string {
  return JSON.stringify([connection.name, connection.host, connection.port]);
}
