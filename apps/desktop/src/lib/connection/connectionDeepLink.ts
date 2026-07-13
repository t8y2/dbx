import type { DatabaseType } from "@/types/database";
import { connectionProfileForScheme, parseConnectionUrl } from "@/lib/connection/connectionUrl";

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
  ssl?: boolean;
  connectionString?: string;
  oracleConnectionType?: "service_name" | "sid";
  useMongoUrl?: boolean;
  oneTime?: boolean;
}

const CONNECTION_DEEP_LINK_TARGET = "connection/new";

function normalizePath(url: URL): string {
  return [url.hostname, url.pathname.replace(/^\/+/, "")].filter(Boolean).join("/").replace(/\/+$/, "");
}

function optionalParam(params: URLSearchParams, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params.get(key)?.trim();
    if (value) return value;
  }
  return undefined;
}

function optionalNumberParam(params: URLSearchParams, ...keys: string[]): number | undefined {
  const value = optionalParam(params, ...keys);
  if (!value) return undefined;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function optionalBooleanParam(params: URLSearchParams, ...keys: string[]): boolean {
  const value = optionalParam(params, ...keys)?.toLowerCase();
  return value === "true" || value === "1" || value === "yes" || value === "on";
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
  const preferredProfile = optionalParam(params, "type");
  const rawConnectionUrl = optionalParam(params, "url");
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
  const explicitPort = optionalNumberParam(params, "port");

  return {
    ...draft,
    name: optionalParam(params, "name") ?? draft.name,
    host: optionalParam(params, "host") ?? draft.host,
    port: explicitPort ?? draft.port,
    ...((explicitPort !== undefined && draft.dbType === "sqlserver") || draft.portExplicit ? { portExplicit: true } : {}),
    username: optionalParam(params, "user") ?? draft.username,
    password: optionalParam(params, "password") ?? draft.password,
    database: optionalParam(params, "database") ?? draft.database,
    urlParams: optionalParam(params, "url_params") ?? draft.urlParams,
    ssl: optionalBooleanParam(params, "ssl") ? true : draft.ssl,
    ...(oneTime ? { oneTime: true } : {}),
  };
}
