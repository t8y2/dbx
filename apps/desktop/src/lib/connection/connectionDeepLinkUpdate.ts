import type { ConnectionConfig } from "@/types/database";
import type { ConnectionDeepLinkUpdate } from "./connectionDeepLink";

function validateUpdateConfig(config: Omit<ConnectionConfig, "id">) {
  if (!["mysql", "postgres", "sqlserver"].includes(config.db_type) || (config.driver_profile && config.driver_profile !== config.db_type) || config.connection_string?.trim()) {
    throw new Error("Connection updates support built-in MySQL, PostgreSQL and SQL Server field-based connections only.");
  }
}

/** Resolve only a saved connection. An invalid update must never become a create. */
export function resolveSavedConnectionForEdit(connectionId: string, connections: readonly ConnectionConfig[]): ConnectionConfig {
  const config = connections.find((connection) => connection.id === connectionId);
  if (!config) throw new Error("The connection to update was not found.");
  if (config.one_time) throw new Error("A saved connection is required for updates.");
  return config;
}

export function resolveConnectionDeepLinkUpdate(update: ConnectionDeepLinkUpdate, connections: readonly ConnectionConfig[], dialogOpen: boolean): ConnectionConfig {
  if (dialogOpen) throw new Error("Close the current connection dialog first.");
  const config = resolveSavedConnectionForEdit(update.connectionId, connections);
  validateUpdateConfig(config);
  return config;
}

/** Apply explicit URL fields to a detached draft, leaving saved data untouched. */
export function applyConnectionDeepLinkUpdate<T extends Omit<ConnectionConfig, "id">>(config: T, update: ConnectionDeepLinkUpdate): T {
  validateUpdateConfig(config);
  const { urlParams, ...fields } = update.patch;
  return applyConnectionEditPatch(config, { ...fields, ...(urlParams !== undefined ? { url_params: urlParams } : {}) });
}

export function applyConnectionEditPatch<T extends Omit<ConnectionConfig, "id">>(config: T, patch: Partial<Omit<ConnectionConfig, "id">>): T {
  const result = { ...config, ...patch };
  if (config.db_type === "sqlserver" && patch.port !== undefined) {
    const external = config.external_config && typeof config.external_config === "object" && !Array.isArray(config.external_config) ? { ...config.external_config } : {};
    delete (external as Record<string, unknown>).port_explicit;
    result.external_config = { ...external, portExplicit: true };
  }
  return result;
}
