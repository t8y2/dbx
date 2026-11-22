import type { ConnectionConfig } from "@/types/database";
import type { PluginConnectionEditFields } from "@/types/pluginConnection";
import type { ConnectionDeepLinkUpdate } from "./connectionDeepLink";
import { applyConnectionDeepLinkUpdate, applyConnectionEditPatch, resolveConnectionDeepLinkUpdate, resolveSavedConnectionForEdit } from "./connectionDeepLinkUpdate";
import { validatePluginConnectionEditTarget } from "./pluginConnectionEdit";
import { parseSqlServerHostPort } from "@/lib/sqlserver/sqlServerHostPort";

export type ConnectionEditPrefill = (ConnectionDeepLinkUpdate & { source?: undefined }) | { source: "plugin"; connectionId: string; patch: PluginConnectionEditFields };

export function resolveConnectionEditPrefill(prefill: ConnectionEditPrefill, connections: readonly ConnectionConfig[], dialogOpen: boolean): ConnectionConfig {
  if (prefill.source !== "plugin") return resolveConnectionDeepLinkUpdate(prefill, connections, dialogOpen);
  if (dialogOpen) throw new Error("Close the current connection dialog first.");
  const config = resolveSavedConnectionForEdit(prefill.connectionId, connections);
  validatePluginConnectionEditTarget(config, prefill.patch);
  return config;
}

export function applyConnectionEditPrefill(config: ConnectionConfig, prefill: ConnectionEditPrefill): ConnectionConfig {
  if (prefill.source !== "plugin") return applyConnectionDeepLinkUpdate(config, prefill);
  const patch = { ...prefill.patch };
  if (config.db_type === "sqlserver" && patch.port !== undefined && patch.host === undefined) {
    // Older saved profiles can encode the port in the hostname field.
    patch.host = parseSqlServerHostPort(config.host, config.port).host;
  }
  return applyConnectionEditPatch(config, patch);
}
