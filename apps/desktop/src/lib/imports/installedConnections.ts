import { invoke } from "@tauri-apps/api/core";
import { parseConnectionConfigObject, selectConnectionConfigBundle, type ConnectionConfigBundle } from "@/lib/connection/connectionConfigTransfer";
import { emptyLayout, mergeSidebarLayout } from "@/lib/sidebar/sidebarLayout";
import type { ConnectionConfig } from "@/types/database";

export interface InstalledConnectionSource {
  source: "dbx" | "navicat" | "dbeaver" | "datagrip" | "rdm";
  label: string;
  path: string;
  content: string;
}

export function discoverInstalledConnections(): Promise<InstalledConnectionSource[]> {
  return invoke("discover_connection_sources");
}

export interface InstalledConnectionGroup extends InstalledConnectionSource {
  preview: ConnectionConfigBundle;
}

export interface InstalledConnectionSelection {
  group: InstalledConnectionGroup;
  connectionIds: string[];
}

export const installedConnectionAppLabels = {
  dbx: "DBX",
  navicat: "Navicat",
  dbeaver: "DBeaver",
  datagrip: "DataGrip",
  rdm: "Redis Desktop Manager",
} as const;

export async function loadInstalledConnectionGroups(): Promise<{ groups: InstalledConnectionGroup[]; errors: string[] }> {
  const sources = await discoverInstalledConnections();
  const groups: InstalledConnectionGroup[] = [];
  const errors: string[] = [];
  for (const source of sources) {
    try {
      let preview: ConnectionConfigBundle;
      if (source.source === "dbeaver") {
        const { parseDbeaverImport } = await import("./dbeaverImport");
        preview = await parseDbeaverImport(source.content);
      } else if (source.source === "datagrip") {
        const { parseDataGripImport } = await import("./datagripImport");
        preview = parseDataGripImport(JSON.parse(source.content));
      } else if (source.source === "navicat") {
        const { parseNavicatConnections } = await import("./navicatImport");
        const wine = isWineSource(source);
        preview = { connections: await parseNavicatConnections(source.content, wine) };
      } else if (source.source === "dbx") {
        preview = parseConnectionConfigObject(JSON.parse(source.content));
      } else {
        const { parseRedisDesktopManagerImport } = await import("./redisDesktopManagerImport");
        preview = parseRedisDesktopManagerImport(JSON.parse(source.content).content);
      }
      if (preview.connections.length) groups.push({ ...source, preview });
    } catch (error) {
      errors.push(`${source.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { groups, errors };
}

export function combineInstalledConnectionSelections(selections: InstalledConnectionSelection[]): ConnectionConfigBundle {
  const combined: ConnectionConfigBundle = { connections: [], layout: emptyLayout(), tunnelProfiles: [] };
  for (const selection of selections) {
    const selected = selectConnectionConfigBundle(selection.group.preview, selection.connectionIds);
    combined.connections.push(...selected.connections);
    combined.tunnelProfiles!.push(...(selected.tunnelProfiles ?? []));
    if (selected.layout) combined.layout = mergeSidebarLayout(combined.layout!, selected.layout);
  }
  return combined;
}

function isWineSource(source: InstalledConnectionSource): boolean {
  if (source.source !== "navicat") return false;
  try {
    return JSON.parse(source.content).format === "navicat-wine-import";
  } catch {
    return false;
  }
}

function connectionIdentity(connection: ConnectionConfig): string {
  const tunnels = (connection.transport_layers ?? []).map((layer) => (layer.type === "ssh" ? [layer.type, layer.host, layer.port, layer.user, layer.auth_method, layer.key_path] : [layer.type]));
  return JSON.stringify([connection.name, connection.db_type, connection.driver_profile || connection.db_type, connection.host, connection.port, connection.username, connection.database || "", connection.connection_string || "", tunnels]);
}

export function planInstalledConnectionImport(selections: InstalledConnectionSelection[], existing: ConnectionConfig[]): { preview: ConnectionConfigBundle; updates: ConnectionConfig[] } {
  const combined = combineInstalledConnectionSelections(selections);
  const wineIds = new Set(selections.filter((selection) => isWineSource(selection.group)).flatMap((selection) => selection.connectionIds));
  const updates: ConnectionConfig[] = [];
  const createIds: string[] = [];
  for (const connection of combined.connections) {
    const matches = wineIds.has(connection.id) ? existing.filter((candidate) => connectionIdentity(candidate) === connectionIdentity(connection)) : [];
    if (matches.length !== 1) {
      createIds.push(connection.id);
      continue;
    }
    const current = matches[0];
    let changed = false;
    const updated = { ...current };
    if (!current.password && connection.password) {
      updated.password = connection.password;
      changed = true;
    }
    updated.transport_layers = (current.transport_layers ?? []).map((layer, index) => {
      const incoming = connection.transport_layers?.[index];
      if (layer.type !== "ssh" || incoming?.type !== "ssh") return layer;
      const password = layer.password || incoming.password;
      const keyPassphrase = layer.key_passphrase || incoming.key_passphrase;
      if (password === layer.password && keyPassphrase === layer.key_passphrase) return layer;
      changed = true;
      return { ...layer, password, key_passphrase: keyPassphrase };
    });
    if (changed) {
      updated.save_password = true;
      updates.push(updated);
    }
  }
  return { preview: selectConnectionConfigBundle(combined, createIds), updates };
}
