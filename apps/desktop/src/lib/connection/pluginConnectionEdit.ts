import type { InjectionKey } from "vue";
import type { ConnectionConfig, DatabaseType } from "@/types/database";
import type { PluginConnectionEditField, PluginConnectionEditFieldKey, PluginConnectionEditFields, PluginConnectionEditor } from "@/types/pluginConnection";
import { mongoConnectionUsesOidc } from "@/lib/mongo/mongoConnectionOptions";
import { isSavedCredential } from "@/lib/security/passwordViewer";

export const PLUGIN_CONNECTION_EDITOR: InjectionKey<PluginConnectionEditor> = Symbol("plugin-connection-editor");

const fieldDefinitions = {
  name: { key: "name", type: "text", maxLength: 256, allowEmpty: false },
  note: { key: "note", type: "text", maxLength: 4096, allowEmpty: true },
  color: { key: "color", type: "color", maxLength: 7, allowEmpty: true },
  host: { key: "host", type: "hostname", maxLength: 255, allowEmpty: false },
  port: { key: "port", type: "integer", min: 1, max: 65535 },
  database: { key: "database", type: "text", maxLength: 4096, allowEmpty: true },
  username: { key: "username", type: "text", maxLength: 4096, allowEmpty: true },
  password: { key: "password", type: "password", maxLength: 4096, allowEmpty: true },
} satisfies Record<PluginConnectionEditFieldKey, PluginConnectionEditField>;

const generalFields = [fieldDefinitions.name, fieldDefinitions.note, fieldDefinitions.color];
const endpointFields = [fieldDefinitions.host, fieldDefinitions.port];
const authenticationFields = [fieldDefinitions.username, fieldDefinitions.password];
const networkFields = [...endpointFields, fieldDefinitions.database, ...authenticationFields];

// These DBX forms use a single host and port plus the standard database/login fields.
// Drivers with different endpoint representations opt in through their own form rules.
const standardNetworkTypes = new Set<DatabaseType>(["mysql", "postgres", "sqlserver", "redshift", "clickhouse"]);

export function pluginConnectionEditFields(config: ConnectionConfig): PluginConnectionEditField[] {
  if (config.connection_string?.trim()) return [...generalFields];
  if (standardNetworkTypes.has(config.db_type)) return [...generalFields, ...networkFields];
  if (config.db_type === "mongodb" && !mongoConnectionUsesOidc(config.url_params)) return [...generalFields, ...networkFields];
  if (config.db_type === "redis") {
    const standalone = !config.redis_connection_mode || config.redis_connection_mode === "standalone";
    return [...generalFields, ...(standalone ? endpointFields : []), ...authenticationFields];
  }
  return [...generalFields];
}

export function requirePluginConnectionEditFields(fields: Record<string, unknown>): PluginConnectionEditFields {
  const patch: PluginConnectionEditFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(fieldDefinitions, key)) throw new Error("Unsupported connection edit field");
    const field = fieldDefinitions[key as PluginConnectionEditFieldKey];
    if (field.type === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < field.min || value > field.max) {
        throw new Error("Connection edit port must be an integer between 1 and 65535");
      }
      patch.port = value;
      continue;
    }
    if (typeof value !== "string" || value.length > field.maxLength || (!field.allowEmpty && !value.trim()) || value.includes("\0")) {
      throw new Error(`Invalid connection edit value for ${field.key}`);
    }
    if (field.type === "password" && isSavedCredential(value)) throw new Error("Connection edits require a password value");
    if (field.type === "hostname" && !isConnectionEditHost(value)) throw new Error("Connection edit host must be a hostname or IP address");
    if (field.type === "color" && value && !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) throw new Error("Connection edit color must be a hex color");
    patch[field.key] = value;
  }
  return patch;
}

export function validatePluginConnectionEditTarget(config: ConnectionConfig, patch: PluginConnectionEditFields): void {
  const allowedFields = new Set<string>(pluginConnectionEditFields(config).map(({ key }) => key));
  if (Object.keys(patch).some((key) => !allowedFields.has(key))) {
    throw new Error("Requested connection edit fields are unavailable for this connection form");
  }
}

function isConnectionEditHost(value: string): boolean {
  if (/^[\p{L}\p{N}._-]+$/u.test(value)) return true;
  if (!/^\[?[0-9a-f.:]+\]?$/i.test(value) || !value.includes(":")) return false;
  const bracketed = value.startsWith("[") ? value : `[${value}]`;
  try {
    return new URL(`http://${bracketed}`).hostname.startsWith("[");
  } catch {
    return false;
  }
}
