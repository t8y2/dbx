import type { ConnectionConfig } from "@/types/database";
import type { ConnectionDeepLinkUpdate } from "./connectionDeepLink";

function validateUpdateConfig(config: Omit<ConnectionConfig, "id">) {
  if (!["mysql", "postgres", "sqlserver"].includes(config.db_type) || (config.driver_profile && config.driver_profile !== config.db_type) || config.connection_string?.trim()) {
    throw new Error("Update links support built-in MySQL, PostgreSQL and SQL Server field-based connections only.");
  }
}

/** Resolve only a saved connection. An invalid update must never become a create. */
export function resolveConnectionDeepLinkUpdate(update: ConnectionDeepLinkUpdate, connections: readonly ConnectionConfig[], dialogOpen: boolean): ConnectionConfig {
  if (dialogOpen) throw new Error("Close the current connection dialog before opening an update link.");
  const config = connections.find((connection) => connection.id === update.connectionId);
  if (!config) throw new Error("The connection specified by the update link was not found.");
  if (config.one_time) throw new Error("Update links require a saved connection, not a one-time connection.");
  validateUpdateConfig(config);
  return config;
}

/** Apply explicit URL fields to a detached draft, leaving saved data untouched. */
export function applyConnectionDeepLinkUpdate<T extends Omit<ConnectionConfig, "id">>(config: T, update: ConnectionDeepLinkUpdate): T {
  validateUpdateConfig(config);
  const { urlParams, ...fields } = update.patch;
  const result = {
    ...config,
    ...fields,
    ...(urlParams !== undefined ? { url_params: urlParams } : {}),
  };
  if (config.db_type === "sqlserver" && update.patch.port !== undefined) {
    const external = config.external_config && typeof config.external_config === "object" && !Array.isArray(config.external_config) ? { ...config.external_config } : {};
    delete (external as Record<string, unknown>).port_explicit;
    result.external_config = { ...external, portExplicit: true };
  }
  return result;
}
