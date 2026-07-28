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

interface SqlServerJdbcParamPart {
  separator: "" | "&" | ";";
  value: string;
}

function splitSqlServerJdbcParams(params: string | undefined): SqlServerJdbcParamPart[] {
  const source = (params || "").trim().replace(/^\?/, "");
  const parts: SqlServerJdbcParamPart[] = [];
  let separator: SqlServerJdbcParamPart["separator"] = "";
  let start = 0;
  let inBraces = false;

  // SQL Server JDBC values use braces to contain separators and `}}` to escape a closing brace.
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inBraces) {
      if (char === "}" && source[index + 1] === "}") {
        index += 1;
      } else if (char === "}") {
        inBraces = false;
      }
    } else if (char === "{") {
      inBraces = true;
    } else if (char === "&" || char === ";") {
      parts.push({ separator, value: source.slice(start, index) });
      separator = char;
      start = index + 1;
    }
  }

  parts.push({ separator, value: source.slice(start) });
  return parts;
}

function isSqlServerLegacyCompatibilityPart(part: string): boolean {
  const separatorIndex = part.indexOf("=");
  if (separatorIndex < 0) return false;
  const key = part.slice(0, separatorIndex).trim().toLowerCase();
  const value = part
    .slice(separatorIndex + 1)
    .trim()
    .toLowerCase();
  return key === "sqlserverencryption" && SQLSERVER_ENCRYPTION_DISABLED_VALUES.has(value);
}

function isSqlServerLegacyCompatibilitySetting(params: string | undefined): boolean {
  return splitSqlServerJdbcParams(params).some((part) => isSqlServerLegacyCompatibilityPart(part.value));
}

function removeSqlServerLegacyCompatibilitySetting(params: string | undefined): string {
  return splitSqlServerJdbcParams(params)
    .filter((part) => part.value.trim() && !isSqlServerLegacyCompatibilityPart(part.value))
    .map((part, index) => `${index === 0 ? "" : part.separator}${part.value}`)
    .join("");
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
