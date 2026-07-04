export interface ZooKeeperEndpoint {
  host: string;
  port: number;
}

const DEFAULT_ZOOKEEPER_PORT = 2181;

export function normalizeZooKeeperConnectString(value: string): string {
  return value
    .split(/[\n,;]+/)
    .map((endpoint) => endpoint.trim())
    .map((endpoint) => endpoint.replace(/^zookeeper:\/\//i, ""))
    .filter(Boolean)
    .join(",");
}

export function firstZooKeeperEndpoint(value?: string): ZooKeeperEndpoint | null {
  const first = normalizeZooKeeperConnectString(value || "")
    .split(",")
    .find(Boolean);
  if (!first) return null;
  return parseZooKeeperEndpoint(first);
}

function parseZooKeeperEndpoint(value: string): ZooKeeperEndpoint {
  const endpoint = value
    .trim()
    .replace(/^zookeeper:\/\//i, "")
    .replace(/^.*@/, "")
    .replace(/[/?#].*$/, "");

  if (endpoint.startsWith("[")) {
    const end = endpoint.indexOf("]");
    if (end > 0) {
      const host = endpoint.slice(1, end);
      const portText = endpoint.slice(end + 1).replace(/^:/, "");
      const port = Number(portText);
      return { host, port: Number.isFinite(port) && port > 0 ? port : DEFAULT_ZOOKEEPER_PORT };
    }
  }

  const parts = endpoint.split(":");
  if (parts.length === 2) {
    const port = Number(parts[1]);
    return { host: parts[0], port: Number.isFinite(port) && port > 0 ? port : DEFAULT_ZOOKEEPER_PORT };
  }
  return { host: endpoint, port: DEFAULT_ZOOKEEPER_PORT };
}
