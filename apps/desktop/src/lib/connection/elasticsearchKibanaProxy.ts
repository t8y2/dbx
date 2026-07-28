export type ElasticsearchConnectionMode = "direct" | "kibana";

export interface ElasticsearchExternalConfig {
  mode?: "kibana" | "direct";
  kibanaBasePath?: string;
  /** GET path for connect/test/health. Empty means GET /. */
  connectivityCheckPath?: string;
}

function externalConfigRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function normalizeKibanaBasePath(value: string): string {
  const path = value.trim().replace(/^\/+|\/+$/g, "");
  return path ? `/${path}` : "";
}

/** Normalize a connectivity-check path. Empty → "" (driver defaults to GET /). */
export function normalizeElasticsearchConnectivityCheckPath(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  const line = raw.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const withoutMethod = line.replace(/^GET\s+/i, "").trim();
  if (!withoutMethod || withoutMethod === "/") return "";
  return withoutMethod.startsWith("/") ? withoutMethod : `/${withoutMethod}`;
}

export function elasticsearchConnectionModeFromConfig(value: unknown): ElasticsearchConnectionMode {
  const config = externalConfigRecord(value);
  return config.mode === "kibana" ? "kibana" : "direct";
}

export function elasticsearchKibanaBasePathFromConfig(value: unknown): string {
  if (elasticsearchConnectionModeFromConfig(value) !== "kibana") return "";
  const config = externalConfigRecord(value);
  const path = config.kibanaBasePath;
  return typeof path === "string" ? normalizeKibanaBasePath(path) : "";
}

export function elasticsearchConnectivityCheckPathFromConfig(value: unknown): string {
  const config = externalConfigRecord(value);
  const path = config.connectivityCheckPath;
  return typeof path === "string" ? normalizeElasticsearchConnectivityCheckPath(path) : "";
}

export function buildElasticsearchExternalConfig(mode: ElasticsearchConnectionMode, kibanaBasePath: string, connectivityCheckPath = ""): ElasticsearchExternalConfig | undefined {
  const checkPath = normalizeElasticsearchConnectivityCheckPath(connectivityCheckPath);
  if (mode !== "kibana") {
    return checkPath ? { connectivityCheckPath: checkPath } : undefined;
  }
  const normalizedPath = normalizeKibanaBasePath(kibanaBasePath);
  const config: ElasticsearchExternalConfig = { mode: "kibana" };
  if (normalizedPath) config.kibanaBasePath = normalizedPath;
  if (checkPath) config.connectivityCheckPath = checkPath;
  return config;
}
