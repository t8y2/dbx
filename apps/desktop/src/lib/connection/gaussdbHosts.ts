export interface GaussdbHostEntry {
  host: string;
  port: number;
}

const DEFAULT_GAUSSDB_PORT = 5432;

function validPort(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : fallback || DEFAULT_GAUSSDB_PORT;
}

function parseEndpoint(value: string, fallbackPort: number): GaussdbHostEntry {
  const endpoint = value.trim();
  if (endpoint.startsWith("[")) {
    const close = endpoint.indexOf("]");
    if (close > 0) {
      const suffix = endpoint.slice(close + 1);
      const parsedPort = suffix.startsWith(":") ? Number(suffix.slice(1)) : fallbackPort;
      return { host: endpoint.slice(1, close), port: validPort(parsedPort, fallbackPort) };
    }
  }
  if ((endpoint.match(/:/g) ?? []).length === 1) {
    const [host, rawPort] = endpoint.split(":");
    const parsedPort = Number(rawPort);
    if (host && Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) return { host, port: parsedPort };
  }
  return { host: endpoint, port: validPort(fallbackPort, DEFAULT_GAUSSDB_PORT) };
}

export function parseGaussdbHosts(host: string, port: number): GaussdbHostEntry[] {
  const fallbackPort = validPort(port, DEFAULT_GAUSSDB_PORT);
  if (!host.trim()) return [{ host: "127.0.0.1", port: fallbackPort }];
  const entries = host
    .split(",")
    .map((part) => parseEndpoint(part, fallbackPort))
    .filter((entry) => entry.host);
  return entries.length ? entries : [{ host: "127.0.0.1", port: fallbackPort }];
}

function formatEndpoint(entry: GaussdbHostEntry): string {
  const host = entry.host.trim();
  const endpointHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${endpointHost}:${validPort(entry.port, DEFAULT_GAUSSDB_PORT)}`;
}

export function serializeGaussdbHosts(entries: readonly GaussdbHostEntry[]): { host: string; port: number } {
  const normalized = entries.map((entry) => ({ host: entry.host.trim(), port: validPort(entry.port, DEFAULT_GAUSSDB_PORT) })).filter((entry) => entry.host);
  if (!normalized.length) return { host: "", port: DEFAULT_GAUSSDB_PORT };
  if (normalized.length === 1) return normalized[0]!;
  return { host: normalized.map(formatEndpoint).join(","), port: normalized[0]!.port };
}
