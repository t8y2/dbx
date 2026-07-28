const KAFKA_BOOTSTRAP_SERVER_SEPARATOR = /[\s,;，；]+/u;
const KAFKA_BOOTSTRAP_SERVER_SCHEME = /^([a-z][a-z0-9_-]*):\/\/(.+)$/iu;
const KAFKA_SECURITY_PROTOCOLS = new Set(["PLAINTEXT", "SSL", "SASL_PLAINTEXT", "SASL_SSL"] as const);

export type KafkaSecurityProtocol = "PLAINTEXT" | "SSL" | "SASL_PLAINTEXT" | "SASL_SSL";

export interface ParsedKafkaBootstrapServers {
  bootstrapServers: string;
  inferredSecurityProtocol?: KafkaSecurityProtocol;
}

function requireKafkaBootstrapServers(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Kafka bootstrap servers are required");
  return trimmed;
}

function normalizeKafkaBootstrapServer(server: string): { address: string; securityProtocol?: KafkaSecurityProtocol } {
  const schemeMatch = server.match(KAFKA_BOOTSTRAP_SERVER_SCHEME);
  let address = server;
  let securityProtocol: KafkaSecurityProtocol | undefined;
  if (schemeMatch) {
    const protocol = schemeMatch[1].toUpperCase();
    if (!KAFKA_SECURITY_PROTOCOLS.has(protocol as KafkaSecurityProtocol)) {
      throw new Error("Kafka bootstrap server protocol is invalid");
    }
    securityProtocol = protocol as KafkaSecurityProtocol;
    address = schemeMatch[2];
  } else if (server.includes("://")) {
    throw new Error("Kafka bootstrap server protocol is invalid");
  }

  let parsed: URL;
  try {
    parsed = new URL(`kafka://${address}`);
  } catch {
    throw new Error("Kafka bootstrap servers are invalid");
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) {
    throw new Error("Kafka bootstrap servers are invalid");
  }
  if (!parsed.port) {
    throw new Error("Kafka bootstrap servers must be host:port values");
  }
  return { address, securityProtocol };
}

export function parseKafkaBootstrapServers(value: string): ParsedKafkaBootstrapServers {
  const parsedServers = requireKafkaBootstrapServers(value)
    .split(KAFKA_BOOTSTRAP_SERVER_SEPARATOR)
    .map((server) => server.trim())
    .filter(Boolean)
    .map(normalizeKafkaBootstrapServer);
  if (!parsedServers.length) throw new Error("Kafka bootstrap servers are required");

  const protocols = new Set(parsedServers.map((server) => server.securityProtocol).filter((protocol): protocol is KafkaSecurityProtocol => !!protocol));
  if (protocols.size > 1) {
    throw new Error("Kafka bootstrap servers must use one security protocol");
  }

  const inferredSecurityProtocol = protocols.values().next().value;
  return {
    bootstrapServers: parsedServers.map((server) => server.address).join(","),
    ...(inferredSecurityProtocol ? { inferredSecurityProtocol } : {}),
  };
}

export function normalizeKafkaBootstrapServers(value: string): string {
  return parseKafkaBootstrapServers(value).bootstrapServers;
}

export function resolveKafkaSecurityProtocol(configured: string, inferred?: KafkaSecurityProtocol): string {
  return configured.trim() || inferred || "";
}
