const KAFKA_BOOTSTRAP_SERVER_SEPARATOR = /[\s,;，；]+/u;

function requireKafkaBootstrapServers(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Kafka bootstrap servers are required");
  return trimmed;
}

function normalizeKafkaBootstrapServer(server: string): string {
  if (server.includes("://")) {
    throw new Error("Kafka bootstrap servers must be host:port values without a URL scheme");
  }
  let parsed: URL;
  try {
    parsed = new URL(`kafka://${server}`);
  } catch {
    throw new Error("Kafka bootstrap servers are invalid");
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) {
    throw new Error("Kafka bootstrap servers are invalid");
  }
  return server;
}

export function normalizeKafkaBootstrapServers(value: string): string {
  const servers = requireKafkaBootstrapServers(value)
    .split(KAFKA_BOOTSTRAP_SERVER_SEPARATOR)
    .map((server) => server.trim())
    .filter(Boolean)
    .map(normalizeKafkaBootstrapServer);
  if (!servers.length) throw new Error("Kafka bootstrap servers are required");
  return servers.join(",");
}
