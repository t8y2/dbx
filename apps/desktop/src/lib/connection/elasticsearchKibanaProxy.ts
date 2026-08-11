export type ElasticsearchConnectionMode = "direct" | "kibana";

export interface ElasticsearchExternalConfig {
  mode?: "kibana" | "direct";
  kibanaBasePath?: string;
  /** GET path for connect/test/health. Empty means GET /. */
  connectivityCheckPath?: string;
  /** Regex collapsing rolling/time-series index suffixes into a `*` pattern. Empty → default; "off" → no grouping. */
  indexGroupingPattern?: string;
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

export function elasticsearchIndexGroupingPatternFromConfig(value: unknown): string {
  const config = externalConfigRecord(value);
  const pattern = config.indexGroupingPattern;
  return typeof pattern === "string" ? pattern.trim() : "";
}

export function buildElasticsearchExternalConfig(mode: ElasticsearchConnectionMode, kibanaBasePath: string, connectivityCheckPath = "", indexGroupingPattern = ""): ElasticsearchExternalConfig | undefined {
  const checkPath = normalizeElasticsearchConnectivityCheckPath(connectivityCheckPath);
  const grouping = indexGroupingPattern.trim();
  if (mode !== "kibana") {
    if (!checkPath && !grouping) return undefined;
    const config: ElasticsearchExternalConfig = {};
    if (checkPath) config.connectivityCheckPath = checkPath;
    if (grouping) config.indexGroupingPattern = grouping;
    return config;
  }
  const normalizedPath = normalizeKibanaBasePath(kibanaBasePath);
  const config: ElasticsearchExternalConfig = { mode: "kibana" };
  if (normalizedPath) config.kibanaBasePath = normalizedPath;
  if (checkPath) config.connectivityCheckPath = checkPath;
  if (grouping) config.indexGroupingPattern = grouping;
  return config;
}
