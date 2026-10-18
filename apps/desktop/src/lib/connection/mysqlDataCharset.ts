import type { ConnectionConfig, QueryTab } from "@/types/database";

export type MysqlDataCharsetConnection = Pick<Partial<ConnectionConfig>, "db_type" | "driver_profile" | "url_params">;
export const MYSQL_DATA_CHARSETS = ["GBK", "GB18030", "BIG5"] as const;

export function supportsMysqlDataCharset(connection?: MysqlDataCharsetConnection | null): boolean {
  const profile = connection?.driver_profile?.trim().toLowerCase();
  return connection?.db_type === "mysql" && (!profile || profile === "mysql");
}

function parameters(params?: string): URLSearchParams {
  return new URLSearchParams((params ?? "").trim().replace(/^\?/, ""));
}

function values(params: URLSearchParams, name: string): string[] {
  return [...params].filter(([key]) => key.trim().toLowerCase() === name.toLowerCase()).map(([, value]) => value);
}

export function mysqlDataCharset(params?: string): string {
  return values(parameters(params), "dataCharset")[0]?.toUpperCase() || "default";
}

export function setMysqlDataCharset(params: string | undefined, value: string): string {
  const parsed = parameters(params);
  const keys = [...parsed.keys()]; // Snapshot before deleting: live iteration skips adjacent duplicate keys.
  for (const key of keys) if (key.trim().toLowerCase() === "datacharset") parsed.delete(key);
  if (value !== "default" && value.trim()) parsed.set("dataCharset", value.trim().toUpperCase());
  return parsed.toString();
}

// Fail closed for unsupported values too; connection validation rejects
// them, but stale unlock state must never turn an invalid opt-in into write access.
export function mysqlDataCharsetEnabled(connection?: MysqlDataCharsetConnection | null): boolean {
  return supportsMysqlDataCharset(connection) && values(parameters(connection?.url_params), "dataCharset").length > 0;
}

export function mysqlDataCharsetValidation(connection: MysqlDataCharsetConnection): string | undefined {
  if (connection.db_type !== "mysql") return;
  const parsed = parameters(connection.url_params);
  const codecs = values(parsed, "dataCharset");
  if (codecs.length === 0) return;
  if (!supportsMysqlDataCharset(connection)) return "connection.mysqlDataCharsetUnsupported";
  if (codecs.length > 1 || !MYSQL_DATA_CHARSETS.some((codec) => codec === codecs[0].toUpperCase())) return "connection.mysqlDataCharsetInvalid";
  const charsets = values(parsed, "charset");
  if (charsets.length > 1 || charsets.some((charset) => charset.toLowerCase() !== "utf8mb4")) return "connection.mysqlDataCharsetConflict";
  if (values(parsed, "sessionVariables").some((value) => value !== "")) return "connection.mysqlDataCharsetConflict";
  if ([...values(parsed, "setupMode"), ...values(parsed, "setup_mode")].some((value) => value.toLowerCase() !== "standard")) return "connection.mysqlDataCharsetConflict";
  if (values(parsed, "proxySql").some((value) => ["", "true", "1", "yes", "on"].includes(value.trim().toLowerCase()))) return "connection.mysqlDataCharsetConflict";
}

export function mysqlDataCharsetAllowsExport(enabled: boolean, format: string): boolean {
  return !enabled || ["csv", "json", "xlsx"].includes(format);
}

export function mysqlDataCharsetChanged(previous: MysqlDataCharsetConnection, next: MysqlDataCharsetConnection): boolean {
  const codec = (connection: MysqlDataCharsetConnection) => (supportsMysqlDataCharset(connection) ? mysqlDataCharset(connection.url_params) : "default");
  return codec(previous) !== codec(next);
}

export function mysqlDataCharsetChangeBlocked(tabs: readonly QueryTab[], connectionId: string): boolean {
  return tabs.some(
    (tab) =>
      tab.connectionId === connectionId && (tab.mode !== "query" || tab.isExecuting || tab.isExplaining || !!tab.txnSessionId || tab.autoCommitOpenTransaction === true || !!tab.result || !!tab.results?.length || !!tab.resultRuns?.length || !!tab.resultSessionId || tab.resultCacheState === "disk"),
  );
}
