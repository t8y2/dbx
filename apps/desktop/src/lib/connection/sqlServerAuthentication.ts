import type { ConnectionConfig } from "@/types/database";
import { parseSqlServerJdbcParams, splitSqlServerJdbcParams } from "@/lib/connection/sqlServerLegacyCompatibility";

export type SqlServerAuthentication = "sql" | "windows";

function authenticationValue(part: string): string | undefined {
  const equals = part.indexOf("=");
  const key = (equals < 0 ? part : part.slice(0, equals)).trim().toLowerCase();
  if (key !== "sqlserverauth") return undefined;
  let value = (equals < 0 ? "" : part.slice(equals + 1)).trim();
  if (value.startsWith("{") && value.endsWith("}")) value = value.slice(1, -1).replace(/}}/g, "}");
  return value.trim().toLowerCase();
}

/** Only DBX's auth setting selects the native mode; JDBC integratedSecurity is independent. */
export function sqlServerAuthentication(params: string | undefined): SqlServerAuthentication | "invalid" {
  const parsed = parseSqlServerJdbcParams(params);
  if (parsed.unterminatedValue) return "invalid";
  let mode: SqlServerAuthentication | undefined;
  for (const part of parsed.parts) {
    const value = authenticationValue(part.value);
    if (value === undefined) continue;
    if ((value !== "sql" && value !== "windows") || (mode !== undefined && mode !== value)) return "invalid";
    mode = value;
  }
  return mode ?? "sql";
}

/** Preserve unrelated JDBC/query values, including braced delimiters and literal percent signs. */
export function setSqlServerAuthentication(params: string | undefined, mode: SqlServerAuthentication): string {
  const parts = splitSqlServerJdbcParams(params);
  const retained = parts.filter((part) => part.value.trim() && authenticationValue(part.value) === undefined);
  const prefix = params?.trim().startsWith("?") ? "?" : "";
  const result = retained.map((part, index) => `${index === 0 ? "" : part.separator}${part.value}`).join("");
  if (mode === "sql") return result ? `${prefix}${result}` : "";
  const separator = parts.find((part) => part.separator)?.separator ?? "&";
  return `${prefix}${result}${result ? separator : ""}sqlserverAuth=windows`;
}

export function sqlServerUsesWindowsAuthentication(config: Pick<ConnectionConfig, "db_type" | "url_params">): boolean {
  return config.db_type === "sqlserver" && sqlServerAuthentication(config.url_params) === "windows";
}
