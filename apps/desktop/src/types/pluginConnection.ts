/**
 * Read-only Plugin Host connection list contract (#12603).
 *
 * Provides a secret-free, read-only list of configured database connections
 * so workbench plugins can display connection pickers and interact with
 * user-selected connections.
 */

/** Permission required by `host.getConnections` / all-connections `host.listConnections`. */
export const PLUGIN_CONNECTIONS_READ_PERMISSION = "host.connections:read";

/** Capability advertised by the bridge when connection listing is available. */
export const PLUGIN_CONNECTIONS_CAPABILITY = "connectionsApi";

export interface PluginConnectionSummary {
  id: string;
  name: string;
  dbType: string;
  dialect: string;
  databaseType?: string;
  connected: boolean;
  isConnected: boolean;
  readOnly: boolean;
  database?: string;
  schema?: string;
  providerId?: string;
  connectionType?: string;
  workbenchTitles?: string[];
  /**
   * Sidebar group of the connection's owning group (t8y2/dbx#15002), filled only
   * by the provider-scoped `host.listConnections` branch; `null` when ungrouped.
   * Plugins feature-detect the key instead of a host_api version.
   */
  groupId?: string | null;
  /** Display name of the owning group, follows `renameConnectionGroup`. */
  groupName?: string | null;
}
