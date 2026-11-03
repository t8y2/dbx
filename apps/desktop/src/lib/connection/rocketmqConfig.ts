import type { MqAdminConfig, MqAuth } from "@/types/mq";
import { normalizeRocketmqNamesrvAddr } from "./rocketmqNamesrv";

export interface RocketMqFields {
  connectionMode: "remoting" | "proxy";
  proxyEndpoint: string;
  proxyTls: boolean;
  managementEnabled: boolean;
  namesrvAddr: string;
  clusterName: string;
}

export function hydrateRocketMqConfig(config?: Partial<MqAdminConfig>): RocketMqFields {
  const extra = config?.extra && typeof config.extra === "object" ? (config.extra as Record<string, unknown>) : {};
  const text = (key: string) => (typeof extra[key] === "string" ? (extra[key] as string) : "");
  return {
    connectionMode: extra.connectionMode === "proxy" ? "proxy" : "remoting",
    proxyEndpoint: text("proxyEndpoint"),
    proxyTls: extra.proxyTls !== false,
    managementEnabled: extra.managementEnabled === true,
    namesrvAddr: text("namesrvAddr") || text("namesrv_addr"),
    clusterName: text("clusterName") || text("cluster_name"),
  };
}

function proxyTarget(value: string) {
  const endpoint = value.trim();
  if (!/^(?:\[[^\]]+\]|[^\s:/,;@?#]+):\d+$/.test(endpoint)) throw new Error("RocketMQ Proxy endpoint must be host:port");
  let parsed: URL;
  try {
    parsed = new URL(`rocketmq://${endpoint}`);
  } catch {
    throw new Error("RocketMQ Proxy endpoint is invalid");
  }
  const port = Number(parsed.port);
  if (!parsed.hostname || port < 1 || port > 65535) throw new Error("RocketMQ Proxy endpoint is invalid");
  return { endpoint, host: parsed.hostname, port };
}

export function buildRocketMqConfig(fields: RocketMqFields, auth: MqAuth = { kind: "none" }, tlsSkipVerify?: boolean): MqAdminConfig {
  const extra: Record<string, unknown> = { connectionMode: fields.connectionMode };
  if (fields.connectionMode === "remoting" || fields.managementEnabled) extra.namesrvAddr = normalizeRocketmqNamesrvAddr(fields.namesrvAddr);
  if (fields.clusterName.trim()) extra.clusterName = fields.clusterName.trim();
  if (fields.connectionMode === "proxy") {
    extra.proxyEndpoint = proxyTarget(fields.proxyEndpoint).endpoint;
    extra.proxyTls = fields.proxyTls;
    extra.managementEnabled = fields.managementEnabled;
  }
  return { systemKind: "rocketmq", adminUrl: "", auth, tlsSkipVerify: tlsSkipVerify || undefined, extra };
}

export function rocketMqConnectionTarget(config: Partial<MqAdminConfig>) {
  const fields = hydrateRocketMqConfig(config);
  if (fields.connectionMode === "proxy") {
    const { host, port } = proxyTarget(fields.proxyEndpoint);
    return { host, port, ssl: fields.proxyTls };
  }
  const first = normalizeRocketmqNamesrvAddr(fields.namesrvAddr).split(";")[0];
  const parsed = new URL(`rocketmq://${first}`);
  return { host: parsed.hostname, port: Number(parsed.port) || 9876, ssl: false };
}

export function isRocketMqConfigValid(fields: RocketMqFields): boolean {
  try {
    buildRocketMqConfig(fields);
    return true;
  } catch {
    return false;
  }
}
