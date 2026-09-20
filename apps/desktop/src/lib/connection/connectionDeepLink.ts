import type { DatabaseType } from "@/types/database";
import { connectionProfileForScheme, parseConnectionUrl } from "@/lib/connection/connectionUrl";

export type ConnectionDeepLinkServiceConfig =
  | { kind: "consul"; serverAddr: string }
  | {
      kind: "nacos";
      profile: "v2" | "v3" | "rnacos";
      serverAddr: string;
      auth: { kind: "none" } | { kind: "usernamePassword"; username: string; password: string };
      rnacosHistoryEnabled?: false;
    };

export interface ConnectionDeepLinkDraft {
  name?: string;
  dbType: DatabaseType;
  driverProfile: string;
  driverLabel: string;
  host?: string;
  port?: number;
  portExplicit?: boolean;
  username?: string;
  password?: string;
  database?: string;
  urlParams?: string;
  basePath?: string;
  ssl?: boolean;
  connectionString?: string;
  oracleConnectionType?: "service_name" | "sid";
  useMongoUrl?: boolean;
  oneTime?: boolean;
  serviceConfig?: ConnectionDeepLinkServiceConfig;
}

export interface ConnectionDeepLinkUpdatePatch {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  urlParams?: string;
  ssl?: boolean;
}

export interface ConnectionDeepLinkUpdate {
  connectionId: string;
  patch: ConnectionDeepLinkUpdatePatch;
}

export function connectionDeepLinkServiceHydrationValue(config: ConnectionDeepLinkServiceConfig): Record<string, unknown> {
  if (config.kind === "consul") return { serverAddr: config.serverAddr };
  if (config.profile === "rnacos") {
    return {
      implementation: "rnacos",
      serverAddr: config.serverAddr,
      rnacosHistoryEnabled: false,
      auth: config.auth,
    };
  }
  return {
    implementation: "nacos",
    versionMode: config.profile,
    serverAddr: config.serverAddr,
    auth: config.auth,
  };
}

const CONNECTION_DEEP_LINK_TARGET = "connection/new";
const CONNECTION_UPDATE_PARAMS = new Set(["id", "v", "name", "host", "port", "user", "password", "database", "url_params", "ssl"]);
// Untrusted pages build these URLs; cap them so a deep link cannot prefill
// unbounded strings into a saved connection's fields.
const CONNECTION_UPDATE_MAX_URL_LENGTH = 16384;
const CONNECTION_UPDATE_MAX_PARAM_LENGTH = 4096;

function normalizePath(url: URL): string {
  return [url.hostname, url.pathname.replace(/^\/+/, "")].filter(Boolean).join("/").replace(/\/+$/, "");
}

/** Parse an explicit-field update without applying the defaults used by new connections. */
export function parseConnectionDeepLinkUpdate(value: string): ConnectionDeepLinkUpdate | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "dbx:" || normalizePath(url) !== CONNECTION_DEEP_LINK_TARGET || !url.searchParams.has("id")) return null;
  if (value.length > CONNECTION_UPDATE_MAX_URL_LENGTH) throw new Error("Connection update URL is too long");
  if (url.username || url.password || url.port || url.hash) throw new Error("Invalid connection update URL");

  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!CONNECTION_UPDATE_PARAMS.has(key)) throw new Error("Unsupported connection update parameter");
    if (params.getAll(key).length !== 1) throw new Error("Duplicate connection update parameter");
    if (params.get(key)!.length > CONNECTION_UPDATE_MAX_PARAM_LENGTH) throw new Error(`Connection update ${key} is too long`);
  }
  if (params.has("v") && params.get("v")?.trim() !== "1") throw new Error("Unsupported connection update version");

  const rawConnectionId = params.get("id")!;
  const connectionId = rawConnectionId.trim();
  if (!connectionId || /[\u0000-\u001f\u007f]/.test(rawConnectionId)) throw new Error("A valid connection ID is required for updates");

  const patch: ConnectionDeepLinkUpdatePatch = {};
  for (const key of ["name", "host"] as const) {
    if (!params.has(key)) continue;
    const text = params.get(key)!.trim();
    if (!text) throw new Error(`Connection update ${key} cannot be empty`);
    patch[key] = text;
  }
  if (params.has("port")) {
    const port = params.get("port")!.trim();
    const number = Number(port);
    if (!/^\d+$/.test(port) || !Number.isInteger(number) || number < 1 || number > 65535) throw new Error("Invalid connection update port");
    patch.port = number;
  }
  // Presence matters: an empty value explicitly clears a field, while omission preserves it.
  // Do not trim credentials; spaces can be part of a username or password.
  if (params.has("user")) patch.username = params.get("user")!;
  if (params.has("password")) patch.password = params.get("password")!;
  if (params.has("database")) patch.database = params.get("database")!;
  if (params.has("url_params")) patch.urlParams = params.get("url_params")!;
  if (params.has("ssl")) {
    const ssl = params.get("ssl")!.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(ssl)) patch.ssl = true;
    else if (["false", "0", "no", "off"].includes(ssl)) patch.ssl = false;
    else throw new Error("Invalid connection update SSL value");
  }
  return { connectionId, patch };
}

function optionalParam(params: URLSearchParams, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params.get(key)?.trim();
    if (value) return value;
  }
  return undefined;
}

function optionalPortParam(params: URLSearchParams, ...keys: string[]): number | undefined {
  const value = optionalParam(params, ...keys);
  if (!value) return undefined;
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 1 || numberValue > 65535) {
    throw new Error(`Invalid connection port: ${value}`);
  }
  return numberValue;
}

function optionalBooleanParam(params: URLSearchParams, ...keys: string[]): boolean | undefined {
  const value = optionalParam(params, ...keys)?.toLowerCase();
  if (value === undefined) return undefined;
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

type ServiceType = "consul" | "nacos-v2" | "nacos-v3" | "r-nacos";

function normalizeServiceType(value?: string): ServiceType | undefined {
  switch (value?.trim().toLowerCase()) {
    case "consul":
      return "consul";
    case "nacos":
    case "nacos-v2":
      return "nacos-v2";
    case "nacos-v3":
      return "nacos-v3";
    case "rnacos":
    case "r-nacos":
      return "r-nacos";
    default:
      return undefined;
  }
}

function validateProtocolVersion(params: URLSearchParams) {
  const version = optionalParam(params, "v");
  if (version !== undefined && version !== "1") {
    throw new Error(`Unsupported connection deep-link version: ${version}`);
  }
}

function validatedServiceHost(value: string): string {
  const rawHost = value.trim();
  if (!rawHost) throw new Error("Service connection host is required");
  const unwrappedHost = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  const authorityHost = unwrappedHost.includes(":") ? `[${unwrappedHost}]` : unwrappedHost;
  let parsed: URL;
  try {
    parsed = new URL(`http://${authorityHost}:1`);
  } catch {
    throw new Error(`Invalid service connection host: ${value}`);
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.port !== "1") {
    throw new Error(`Invalid service connection host: ${value}`);
  }
  return parsed.hostname;
}

function serviceEndpoint(rawConnectionUrl: string | undefined, serviceType: ServiceType, host: string | undefined, port: number, ssl: boolean): string {
  let endpoint: URL;
  if (rawConnectionUrl) {
    try {
      endpoint = new URL(rawConnectionUrl);
    } catch {
      throw new Error("Invalid service connection URL");
    }
    const sourceScheme = endpoint.protocol.replace(/:$/, "").toLowerCase();
    const serviceScheme = normalizeServiceType(sourceScheme);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:" && serviceScheme !== serviceType) {
      throw new Error(`Unsupported service connection URL scheme: ${sourceScheme}`);
    }
    if (endpoint.search || endpoint.hash) throw new Error("Service connection URL must not contain query parameters or a fragment");
    if (serviceScheme) {
      const pathname = endpoint.pathname;
      const hostWithPort = endpoint.host;
      if (!hostWithPort) throw new Error("Service connection URL must include a host");
      endpoint = new URL(`http://${hostWithPort}`);
      endpoint.pathname = pathname;
    }
  } else {
    const endpointHost = validatedServiceHost(host || "127.0.0.1");
    endpoint = new URL(`${ssl ? "https" : "http"}://${endpointHost}:${port}`);
  }

  endpoint.username = "";
  endpoint.password = "";
  endpoint.protocol = ssl ? "https:" : "http:";
  if (host) endpoint.hostname = validatedServiceHost(host);
  endpoint.port = String(port);
  return endpoint.toString().replace(/\/$/, "");
}

function serviceConfigForDraft(serviceType: ServiceType | undefined, rawConnectionUrl: string | undefined, host: string | undefined, port: number | undefined, ssl: boolean | undefined, username: string | undefined, password: string | undefined): ConnectionDeepLinkServiceConfig | undefined {
  if (!serviceType) return undefined;
  const defaultPort = serviceType === "consul" ? 8500 : 8848;
  const serverAddr = serviceEndpoint(rawConnectionUrl, serviceType, host, port ?? defaultPort, ssl ?? false);
  if (serviceType === "consul") return { kind: "consul", serverAddr };
  if (password && !username) throw new Error("Nacos username is required when a password is provided");
  const auth = username ? { kind: "usernamePassword" as const, username, password: password || "" } : { kind: "none" as const };
  return {
    kind: "nacos",
    profile: serviceType === "nacos-v3" ? "v3" : serviceType === "r-nacos" ? "rnacos" : "v2",
    serverAddr,
    auth,
    ...(serviceType === "r-nacos" ? { rnacosHistoryEnabled: false as const } : {}),
  };
}

function draftFromConnectionUrl(value: string, preferredProfile?: string): ConnectionDeepLinkDraft {
  const parsed = parseConnectionUrl(value, preferredProfile);
  return {
    name: parsed.name,
    dbType: parsed.dbType,
    driverProfile: parsed.driverProfile,
    driverLabel: parsed.driverLabel,
    host: parsed.host,
    port: parsed.port,
    portExplicit: parsed.portExplicit,
    username: parsed.username,
    password: parsed.password,
    database: parsed.database,
    urlParams: parsed.urlParams,
    basePath: parsed.basePath,
    ssl: parsed.ssl,
    connectionString: parsed.connectionString,
    oracleConnectionType: parsed.oracleConnectionType,
    useMongoUrl: parsed.useMongoUrl,
  };
}

export function parseConnectionDeepLink(value: string): ConnectionDeepLinkDraft | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "dbx:") return null;
  if (normalizePath(url) !== CONNECTION_DEEP_LINK_TARGET) return null;

  const params = url.searchParams;
  if (params.has("id")) throw new Error("Connection update link cannot create a new connection");
  validateProtocolVersion(params);
  const preferredProfile = optionalParam(params, "type")?.toLowerCase();
  const rawConnectionUrl = optionalParam(params, "url");
  let serviceType = normalizeServiceType(preferredProfile);
  if (!serviceType && rawConnectionUrl) {
    try {
      serviceType = normalizeServiceType(new URL(rawConnectionUrl).protocol.replace(/:$/, ""));
    } catch {
      // parseConnectionUrl below reports the canonical invalid URL error.
    }
  }
  const draft: ConnectionDeepLinkDraft = rawConnectionUrl
    ? draftFromConnectionUrl(rawConnectionUrl, preferredProfile)
    : (() => {
        const profile = connectionProfileForScheme(preferredProfile || "mysql");
        if (!profile) throw new Error(`Unsupported connection type: ${preferredProfile}`);
        return {
          dbType: profile.type,
          driverProfile: profile.profile,
          driverLabel: profile.label,
          port: profile.defaultPort,
          ssl: false,
        };
      })();

  const oneTime = optionalBooleanParam(params, "one_time");
  const explicitPort = optionalPortParam(params, "port");
  const explicitSsl = optionalBooleanParam(params, "ssl");
  const host = optionalParam(params, "host") ?? draft.host;
  const port = explicitPort ?? draft.port;
  const username = optionalParam(params, "user") ?? draft.username;
  const password = optionalParam(params, "password") ?? draft.password;
  const ssl = explicitSsl ?? draft.ssl;
  const serviceConfig = serviceConfigForDraft(serviceType, rawConnectionUrl, host, port, ssl, username, password);

  return {
    ...draft,
    name: optionalParam(params, "name") ?? draft.name,
    host,
    port,
    ...((explicitPort !== undefined && draft.dbType === "sqlserver") || draft.portExplicit ? { portExplicit: true } : {}),
    username,
    password,
    database: optionalParam(params, "database") ?? draft.database,
    urlParams: optionalParam(params, "url_params") ?? draft.urlParams,
    ssl,
    ...(oneTime !== undefined ? { oneTime } : {}),
    ...(serviceConfig ? { serviceConfig } : {}),
  };
}

export function parseServiceConnectionUrl(value: string): ConnectionDeepLinkDraft | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const serviceType = normalizeServiceType(url.protocol.replace(/:$/, ""));
  if (!serviceType) return null;

  const deepLink = new URL("dbx://connection/new");
  deepLink.searchParams.set("type", serviceType);
  deepLink.searchParams.set("url", value);
  return parseConnectionDeepLink(deepLink.toString());
}
