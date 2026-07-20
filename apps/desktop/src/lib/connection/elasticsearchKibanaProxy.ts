export type ElasticsearchConnectionMode = "direct" | "kibana";

export interface ElasticsearchExternalConfig {
  mode: "kibana";
  kibanaBasePath?: string;
}

function externalConfigRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function normalizeKibanaBasePath(value: string): string {
  const path = value.trim().replace(/^\/+|\/+$/g, "");
  return path ? `/${path}` : "";
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

export function buildElasticsearchExternalConfig(mode: ElasticsearchConnectionMode, kibanaBasePath: string): ElasticsearchExternalConfig | undefined {
  if (mode !== "kibana") return undefined;
  const normalizedPath = normalizeKibanaBasePath(kibanaBasePath);
  return normalizedPath ? { mode: "kibana", kibanaBasePath: normalizedPath } : { mode: "kibana" };
}
