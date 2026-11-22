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

/** Opens a host-owned edit draft for user review. */
export const PLUGIN_CONNECTION_EDIT_PERMISSION = "host.connections:edit";
export const PLUGIN_CONNECTION_EDIT_CAPABILITY = "connectionEditApi";

export interface PluginConnectionEditFields {
  name?: string;
  note?: string;
  color?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
}

export type PluginConnectionEditFieldKey = keyof PluginConnectionEditFields;

export type PluginConnectionEditField = { key: Exclude<PluginConnectionEditFieldKey, "port">; type: "text" | "hostname" | "password" | "color"; maxLength: number; allowEmpty: boolean } | { key: "port"; type: "integer"; min: number; max: number };

export interface PluginConnectionEditRequest {
  connectionId: string;
  fields?: PluginConnectionEditFields;
}

export interface PluginConnectionEditor {
  getFields(connectionId: string): PluginConnectionEditField[];
  openEdit(request: PluginConnectionEditRequest): void;
}

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
}
