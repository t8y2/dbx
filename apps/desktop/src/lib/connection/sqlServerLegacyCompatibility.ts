import type { ConnectionConfig } from "@/types/database";

export const SQLSERVER_LEGACY_COMPATIBILITY_DRIVER_KEY = "sqlserver-legacy";

const SQLSERVER_LEGACY_DISABLED_VALUES = new Set(["disabled", "disable", "false", "0", "off", "no"]);

export function isSqlServerLegacyCompatibilityMode(params: string | undefined): boolean {
  const normalized = (params || "").trim().replace(/^\?/, "").replace(/;/g, "&");
  if (!normalized) return false;
  const parsed = new URLSearchParams(normalized);
  for (const [key, value] of parsed.entries()) {
    const normalizedKey = key.trim().toLowerCase();
    if (normalizedKey === "sqlserverencryption" || normalizedKey === "encrypt") {
      // Accept JDBC-style `encrypt=false` from imported SQL Server URLs as the same opt-in.
      if (SQLSERVER_LEGACY_DISABLED_VALUES.has(value.trim().toLowerCase())) return true;
    }
  }
  return false;
}

export function setSqlServerLegacyCompatibilityMode(params: string | undefined, enabled: boolean): string {
  const normalized = (params || "").trim().replace(/^\?/, "").replace(/;/g, "&");
  const parsed = new URLSearchParams(normalized);
  for (const key of Array.from(parsed.keys())) {
    const normalizedKey = key.trim().toLowerCase();
    if (normalizedKey === "sqlserverencryption" || normalizedKey === "encrypt") parsed.delete(key);
  }
  if (enabled) parsed.set("sqlserverEncryption", "disabled");
  return parsed.toString();
}

export function requiresSqlServerLegacyCompatibilityComponent(config: ConnectionConfig): boolean {
  return config.db_type === "sqlserver" && isSqlServerLegacyCompatibilityMode(config.url_params);
}
