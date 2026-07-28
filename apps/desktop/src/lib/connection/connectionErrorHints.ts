import type { ConnectionConfig } from "@/types/database";

type Translate = (key: string) => string;

function normalizeUrlParams(params: string | undefined): URLSearchParams {
  return new URLSearchParams((params || "").trim().replace(/^\?/, ""));
}

function normalizeUrlParamKey(key: string): string {
  return key.trim().toLowerCase().replace(/[-_]/g, "");
}

function urlParamValue(params: URLSearchParams, key: string): string {
  const normalizedKey = normalizeUrlParamKey(key);
  for (const [paramKey, value] of params.entries()) {
    if (normalizeUrlParamKey(paramKey) === normalizedKey) return value;
  }
  return "";
}

function mysqlTlsMode(config: ConnectionConfig): string {
  const parsed = normalizeUrlParams(config.url_params);
  // MySQL clients use ssl-mode, sslmode and sslMode spellings; keep hint behavior aligned with backend parsing.
  const mode = urlParamValue(parsed, "ssl-mode").trim().toLowerCase().replace("-", "_");
  if (["disabled", "disable"].includes(mode)) return "disabled";
  if (["preferred", "prefer"].includes(mode)) return "preferred";
  if (["required", "require", "verify_ca", "verify_identity"].includes(mode)) return mode;
  if (config.ssl || ["true", "1", "yes", "on"].includes(urlParamValue(parsed, "require_ssl").trim().toLowerCase())) return "required";
  return "disabled";
}

function isMysqlTlsLikeFailure(message: string): boolean {
  const text = message.toLowerCase();
  return (
    (text.includes("mysql") || text.includes("mariadb") || text.includes("tidb") || text.includes("tls") || text.includes("ssl")) &&
    (text.includes("tls") || text.includes("ssl") || text.includes("handshake") || text.includes("certificate") || text.includes("cert") || text.includes("unknown ca") || text.includes("self signed"))
  );
}

export function isJdbcMissingRuntimeDependencyError(message: string): boolean {
  return /Missing Java class|NoClassDefFoundError|ClassNotFoundException/i.test(message);
}

function appendHint(message: string, hint: string): string {
  return message.includes(hint) ? message : `${message}\n\n${hint}`;
}

export function appendConnectionErrorHints(config: ConnectionConfig | undefined, message: string, t: Translate): string {
  if (!config) return message;
  let result = message;
  if (config.db_type === "jdbc" && isJdbcMissingRuntimeDependencyError(message)) {
    result = appendHint(result, t("connection.jdbcMissingRuntimeDependencyHint"));
  }
  if (config.db_type !== "mysql") return result;
  if (mysqlTlsMode(config) === "disabled") return message;
  if (!isMysqlTlsLikeFailure(message)) return message;
  const hint = t("connection.mysqlTlsConnectionFailureHint");
  return appendHint(message, hint);
}
