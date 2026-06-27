import type { ConnectionConfig } from "@/types/database";

export type H2ConnectionMode = "file" | "tcp";

const H2_FILE_PREFIX = "jdbc:h2:file:";
const H2_SPLIT_PREFIX = "jdbc:h2:split:";
const H2_FILE_PREFIXES = [H2_FILE_PREFIX, H2_SPLIT_PREFIX];
const H2_DEFAULT_PORT = 9092;
const H2_PARSED_PROFILE = {
  dbType: "h2" as const,
  driverProfile: "h2" as const,
  driverLabel: "H2" as const,
};

function decodeH2UrlPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractH2JdbcSemicolonParams(source: string): { username?: string; password?: string; urlParams: string } {
  let username: string | undefined;
  let password: string | undefined;
  const urlParams: string[] = [];

  for (const part of source.split(";").slice(1)) {
    if (!part) continue;
    const [rawKey, ...rest] = part.split("=");
    const key = decodeH2UrlPart(rawKey).trim().toLowerCase();
    const value = decodeH2UrlPart(rest.join("=")).trim();
    if (key === "user") {
      username = value;
    } else if (key === "password") {
      password = value;
    } else {
      urlParams.push(part);
    }
  }

  return { username, password, urlParams: urlParams.join(";") };
}

function hasH2JdbcSemicolonParam(source: string | undefined, name: string): boolean {
  for (const part of (source || "").split(";").slice(1)) {
    if (!part) continue;
    const [rawKey] = part.split("=");
    if (decodeH2UrlPart(rawKey).trim().toLowerCase() === name) return true;
  }
  return false;
}

export function h2JdbcUrlHasUserParam(source: string | undefined): boolean {
  return hasH2JdbcSemicolonParam(source, "user");
}

export function h2JdbcUrlHasPasswordParam(source: string | undefined): boolean {
  return hasH2JdbcSemicolonParam(source, "password");
}

function databaseNameFromPath(path: string): string | undefined {
  const name = path.split(/[\\/]/).filter(Boolean).pop()?.trim();
  return name || undefined;
}

function h2FileJdbcUrlPrefix(value: string): string | undefined {
  const lower = value.toLowerCase();
  return H2_FILE_PREFIXES.find((prefix) => lower.startsWith(prefix));
}

export function isH2FileJdbcUrl(value: string | undefined | null): boolean {
  return h2FileJdbcUrlPrefix((value || "").trim()) !== undefined;
}

export function h2FilePathFromJdbcUrl(value: string | undefined | null): string {
  const trimmed = (value || "").trim();
  const prefix = h2FileJdbcUrlPrefix(trimmed);
  if (!prefix) return "";
  const rawPath = trimmed.slice(prefix.length).split(";")[0] || "";
  if (prefix === H2_SPLIT_PREFIX) {
    return rawPath.replace(/^\d+:/, "");
  }
  return rawPath;
}

export function isH2SplitJdbcUrl(value: string | undefined | null): value is string {
  return (value || "").trim().toLowerCase().startsWith(H2_SPLIT_PREFIX);
}

export function h2FileJdbcUrlWithPath(source: string | undefined | null, path: string): string {
  const trimmed = (source || "").trim();
  if (!isH2SplitJdbcUrl(trimmed)) return h2FileJdbcUrl(path);

  const rest = trimmed.slice(H2_SPLIT_PREFIX.length);
  const [rawPath, ...optionParts] = rest.split(";");
  const blockPrefix = rawPath.match(/^\d+:/)?.[0] || "";
  const options = optionParts.length > 0 ? `;${optionParts.join(";")}` : "";
  return `${H2_SPLIT_PREFIX}${blockPrefix}${h2JdbcFileBasePath(path)}${options}`;
}

export function parseH2JdbcUrl(source: string) {
  const trimmed = source.trim();
  if (!/^jdbc:h2:/i.test(trimmed)) return null;

  const credentials = extractH2JdbcSemicolonParams(trimmed);
  const filePath = h2FilePathFromJdbcUrl(trimmed);
  if (filePath) {
    return {
      ...H2_PARSED_PROFILE,
      host: filePath,
      port: 0,
      username: credentials.username || "sa",
      password: credentials.password || "",
      database: databaseNameFromPath(filePath),
      urlParams: credentials.urlParams,
      ssl: false,
      connectionString: trimmed,
    };
  }

  const serverMatch = /^jdbc:h2:(?<protocol>tcp|ssl):\/\/(?<host>\[[^\]]+\]|[^:/;]+)(?::(?<port>\d+))?\/(?<database>[^;]*)/i.exec(trimmed);
  if (serverMatch?.groups) {
    return {
      ...H2_PARSED_PROFILE,
      host: serverMatch.groups.host.replace(/^\[/, "").replace(/\]$/, ""),
      port: serverMatch.groups.port ? Number(serverMatch.groups.port) : H2_DEFAULT_PORT,
      username: credentials.username || "sa",
      password: credentials.password || "",
      database: decodeH2UrlPart(serverMatch.groups.database || "") || undefined,
      urlParams: credentials.urlParams,
      ssl: serverMatch.groups.protocol.toLowerCase() === "ssl",
      connectionString: trimmed,
    };
  }

  const database = trimmed.replace(/^jdbc:h2:/i, "").split(";")[0] || undefined;
  return {
    ...H2_PARSED_PROFILE,
    host: "",
    port: H2_DEFAULT_PORT,
    username: credentials.username || "sa",
    password: credentials.password || "",
    database: database ? decodeH2UrlPart(database) : undefined,
    urlParams: credentials.urlParams,
    ssl: false,
    connectionString: trimmed,
  };
}

export function h2JdbcFileBasePath(path: string): string {
  const trimmed = path.trim();
  if (/\.mv\.db$/i.test(trimmed)) return trimmed.slice(0, -".mv.db".length);
  if (/\.h2\.db$/i.test(trimmed)) return trimmed.slice(0, -".h2.db".length);
  return trimmed;
}

export function h2FileJdbcUrl(path: string): string {
  return `${H2_FILE_PREFIX}${h2JdbcFileBasePath(path)};AUTO_SERVER=TRUE`;
}

export function h2ConnectionModeForConfig(config: Pick<ConnectionConfig, "db_type" | "connection_string" | "port">) {
  if (config.db_type !== "h2") return "tcp";
  return isH2FileJdbcUrl(config.connection_string) || config.port === 0 ? "file" : "tcp";
}
