import type { ConnectionConfig } from "@/types/database";

export const SQLSERVER_LEGACY_COMPATIBILITY_DRIVER_KEY = "sqlserver-legacy";
export const SQLSERVER_LEGACY_COMPATIBILITY_DRIVER_LABEL = "SQL Server legacy compatibility component";
export const SQLSERVER_NATIVE_DRIVER_PROFILE = "sqlserver";
export const SQLSERVER_NATIVE_DRIVER_LABEL = "SQL Server";

const SQLSERVER_ENCRYPTION_DISABLED_VALUES = new Set(["disabled", "disable", "false", "0", "off", "no"]);

export function isSqlServerNativeEncryptionDisabled(params: string | undefined): boolean {
  const normalized = (params || "").trim().replace(/^\?/, "").replace(/;/g, "&");
  if (!normalized) return false;
  const parsed = new URLSearchParams(normalized);
  for (const [key, value] of parsed.entries()) {
    const normalizedKey = key.trim().toLowerCase();
    if (normalizedKey === "sqlserverencryption" || normalizedKey === "encrypt") {
      if (SQLSERVER_ENCRYPTION_DISABLED_VALUES.has(value.trim().toLowerCase())) return true;
    }
  }
  return false;
}

export function setSqlServerNativeEncryptionDisabled(params: string | undefined, disabled: boolean): string {
  const normalized = (params || "").trim().replace(/^\?/, "").replace(/;/g, "&");
  const parsed = new URLSearchParams(normalized);
  for (const key of Array.from(parsed.keys())) {
    const normalizedKey = key.trim().toLowerCase();
    if (normalizedKey === "sqlserverencryption" || normalizedKey === "encrypt") parsed.delete(key);
  }
  if (disabled) parsed.set("sqlserverEncryption", "disabled");
  return parsed.toString();
}

function isSqlServerLegacyCompatibilitySetting(params: string | undefined): boolean {
  return (params || "")
    .trim()
    .replace(/^\?/, "")
    .split(/[&;]/)
    .some((part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex < 0) return false;
      const key = part.slice(0, separatorIndex).trim().toLowerCase();
      const value = part
        .slice(separatorIndex + 1)
        .trim()
        .toLowerCase();
      return key === "sqlserverencryption" && SQLSERVER_ENCRYPTION_DISABLED_VALUES.has(value);
    });
}

function removeSqlServerLegacyCompatibilitySetting(params: string | undefined): string {
  // Preserve raw JDBC values because the legacy agent does not URL-decode properties.
  return (params || "")
    .trim()
    .replace(/^\?/, "")
    .split(/[&;]/)
    .map((part) => part.trim())
    .filter((part) => part && !isSqlServerLegacyCompatibilitySetting(part))
    .join("&");
}

export function sqlServerUsesLegacyCompatibility(config: Pick<ConnectionConfig, "db_type" | "driver_profile">): boolean {
  return config.db_type === "sqlserver" && config.driver_profile === SQLSERVER_LEGACY_COMPATIBILITY_DRIVER_KEY;
}

export function setSqlServerLegacyCompatibilityConfig(config: Pick<ConnectionConfig, "driver_label" | "driver_profile">, enabled: boolean): void {
  config.driver_profile = enabled ? SQLSERVER_LEGACY_COMPATIBILITY_DRIVER_KEY : SQLSERVER_NATIVE_DRIVER_PROFILE;
  config.driver_label = enabled ? SQLSERVER_LEGACY_COMPATIBILITY_DRIVER_LABEL : SQLSERVER_NATIVE_DRIVER_LABEL;
}

export function migrateSqlServerLegacyCompatibilityConfig(config: Pick<ConnectionConfig, "db_type" | "driver_label" | "driver_profile" | "url_params">): void {
  if (config.db_type !== "sqlserver" || !isSqlServerLegacyCompatibilitySetting(config.url_params)) return;
  setSqlServerLegacyCompatibilityConfig(config, true);
  config.url_params = removeSqlServerLegacyCompatibilitySetting(config.url_params);
}

export function requiresSqlServerLegacyCompatibilityComponent(config: ConnectionConfig): boolean {
  return sqlServerUsesLegacyCompatibility(config);
}
