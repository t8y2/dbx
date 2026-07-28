import { parseKafkaBootstrapServers, resolveKafkaSecurityProtocol } from "@/lib/connection/kafkaBootstrapServers";
import { firstZooKeeperEndpoint, normalizeZooKeeperConnectString } from "@/lib/zookeeper/zookeeperConnection";

export type MqKafkaConnectionSource = "bootstrap" | "zookeeper";

export interface MqKafkaConnectionInput {
  connectionSource: MqKafkaConnectionSource;
  bootstrapServers: string;
  zookeeperServers: string;
  securityProtocol?: string;
}

export interface MqKafkaConnectionTarget {
  host: string;
  port: number;
  ssl: boolean;
}

export function resolveMqKafkaConnectionSource(extra: Record<string, unknown>): MqKafkaConnectionSource {
  if (extra.connectionSource === "zookeeper") return "zookeeper";
  if (typeof extra.zookeeperServers === "string" && extra.zookeeperServers.trim() && !(typeof extra.bootstrapServers === "string" && extra.bootstrapServers.trim())) {
    return "zookeeper";
  }
  return "bootstrap";
}

export function normalizeMqKafkaZooKeeperServers(value: string): string {
  const normalized = normalizeZooKeeperConnectString(value.trim());
  if (!normalized) throw new Error("Kafka ZooKeeper servers are required");

  const chrootIndex = normalized.indexOf("/");
  const ensemble = chrootIndex >= 0 ? normalized.slice(0, chrootIndex) : normalized;
  const chroot = chrootIndex >= 0 ? normalized.slice(chrootIndex) : "";
  if (chroot && (!chroot.startsWith("/") || chroot.includes("//"))) {
    throw new Error("Kafka ZooKeeper servers are invalid");
  }

  for (const endpoint of ensemble.split(",")) {
    const match = endpoint.match(/^(?:\[[^\]]+\]|[^:\s/?#]+):(\d+)$/u);
    const port = match ? Number(match[1]) : Number.NaN;
    if (!match || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Kafka ZooKeeper servers are invalid");
    }
  }
  return normalized;
}

export function buildMqKafkaConnectionExtra(input: MqKafkaConnectionInput): Record<string, string> {
  let extra: Record<string, string>;
  let securityProtocol = input.securityProtocol?.trim() || "";

  if (input.connectionSource === "zookeeper") {
    extra = {
      connectionSource: "zookeeper",
      zookeeperServers: normalizeMqKafkaZooKeeperServers(input.zookeeperServers),
    };
  } else {
    const parsed = parseKafkaBootstrapServers(input.bootstrapServers);
    securityProtocol = resolveKafkaSecurityProtocol(securityProtocol, parsed.inferredSecurityProtocol);
    extra = { bootstrapServers: parsed.bootstrapServers };
  }

  if (securityProtocol) extra.securityProtocol = securityProtocol;
  return extra;
}

export function mqKafkaConnectionTarget(input: MqKafkaConnectionInput): MqKafkaConnectionTarget {
  if (input.connectionSource === "zookeeper") {
    const endpoint = firstZooKeeperEndpoint(normalizeMqKafkaZooKeeperServers(input.zookeeperServers));
    if (!endpoint) throw new Error("Kafka ZooKeeper servers are required");
    return { ...endpoint, ssl: false };
  }

  const parsed = parseKafkaBootstrapServers(input.bootstrapServers);
  const first = parsed.bootstrapServers.split(",")[0];
  const endpoint = new URL(`kafka://${first}`);
  const securityProtocol = resolveKafkaSecurityProtocol(input.securityProtocol || "", parsed.inferredSecurityProtocol);
  return {
    host: endpoint.hostname,
    port: Number(endpoint.port),
    ssl: securityProtocol === "SSL" || securityProtocol === "SASL_SSL",
  };
}
