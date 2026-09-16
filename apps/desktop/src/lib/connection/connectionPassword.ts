import type { ConnectionConfig, PluginFormField, PluginFormFieldValue } from "@/types/database";
import { pluginFieldIsRequired } from "@/lib/plugins/pluginFieldConditions";

type PasswordAuthenticationConfig = Pick<ConnectionConfig, "db_type" | "driver_profile" | "url_params">;

function hiveServerUrlParams(urlParams?: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const part of (urlParams || "").replace(/^[?&;]+|[?&;]+$/g, "").split(/[;&]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf("=");
    const key = (equals < 0 ? trimmed : trimmed.slice(0, equals)).trim().toLowerCase();
    const value = (equals < 0 ? "" : trimmed.slice(equals + 1)).trim();
    if (key) params.set(key, value);
  }
  return params;
}

export function connectionUsesPasswordlessAuthentication(config: PasswordAuthenticationConfig): boolean {
  const profile = config.driver_profile || config.db_type;
  const isImpala = config.db_type === "impala" || profile === "impala";
  const isKyuubi = config.db_type === "kyuubi" || profile === "kyuubi";
  if (!isImpala && !isKyuubi) return false;

  const params = hiveServerUrlParams(config.url_params);
  if (params.get("principal")) return false;
  const auth = (params.get("auth") || (isKyuubi ? "none" : "nosasl")).toLowerCase();
  return isKyuubi ? auth === "none" || auth === "nosasl" : auth === "nosasl";
}

export function connectionNeedsPasswordPrompt(config: ConnectionConfig): boolean {
  return config.save_password === false && !config.password && !connectionUsesPasswordlessAuthentication(config);
}

/**
 * Manifest-driven re-check for plugin connections. The shared prompt can only
 * collect a field bound to `password`, so it applies only when the plugin's
 * manifest marks that field required for the connection's current
 * external_config. Auth modes that do not consume a login password (e.g. SSH
 * private key / agent) declare no matching `required_when` and must connect
 * without the prompt, even when save_password is disabled and no password is
 * stored.
 */
export function pluginConnectionNeedsPasswordPrompt(fields: readonly PluginFormField[], externalConfig: unknown): boolean {
  const passwordFields = fields.filter((field) => field.binding === "password");
  if (!passwordFields.length) return false;
  const readValue = (key: string): PluginFormFieldValue => {
    const stored = isRecord(externalConfig) ? (externalConfig[key] as PluginFormFieldValue) : undefined;
    return stored !== undefined ? stored : fields.find((candidate) => candidate.key === key)?.default;
  };
  return passwordFields.some((field) => pluginFieldIsRequired(field, readValue));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
