import type { ConnectionConfig } from "@/types/database";
import type { MqAdminConfig, MqCapabilities, MqSystemKind } from "@/types/mq";

const FLAT_MQ_BASE_CAPABILITIES: MqCapabilities = {
  supportsTenants: false,
  supportsNamespaces: false,
  supportsPartitionedTopics: true,
  supportsSubscriptions: true,
  supportsCreateSubscription: false,
  supportsResetCursor: true,
  supportsSkipMessages: false,
  supportsClearBacklog: true,
  supportsPeekMessages: true,
  supportsExpireMessages: false,
  supportsRateLimits: false,
  supportsBacklogQuota: false,
  supportsRetention: false,
  supportsPermissions: true,
  supportsGeoReplication: false,
  supportsTokenManagement: false,
  supportsRawAdminApi: false,
  supportsSendMessage: true,
  supportsMessageQuery: false,
  supportsDlq: false,
  supportsMessageTrace: false,
  supportsExchanges: false,
  supportsClientConnections: false,
};

const PULSAR_DEFAULT_CAPABILITIES: MqCapabilities = {
  supportsTenants: true,
  supportsNamespaces: true,
  supportsPartitionedTopics: true,
  supportsSubscriptions: true,
  supportsCreateSubscription: true,
  supportsResetCursor: true,
  supportsSkipMessages: true,
  supportsClearBacklog: true,
  supportsPeekMessages: true,
  supportsExpireMessages: true,
  supportsRateLimits: true,
  supportsBacklogQuota: true,
  supportsRetention: true,
  supportsPermissions: true,
  supportsGeoReplication: true,
  supportsTokenManagement: true,
  supportsRawAdminApi: true,
  supportsSendMessage: false,
  supportsMessageQuery: false,
  supportsDlq: false,
  supportsMessageTrace: false,
};

export function resolveMqSystemKindFromConnection(config: ConnectionConfig | undefined): MqSystemKind | undefined {
  if (!config || config.db_type !== "mq") return undefined;
  const external = config.external_config as Partial<MqAdminConfig> | undefined;
  if (external?.systemKind === "kafka" || external?.systemKind === "rocketmq" || external?.systemKind === "rabbitmq" || external?.systemKind === "pulsar") {
    return external.systemKind;
  }
  if (config.driver_profile === "kafka" || config.driver_profile === "rocketmq" || config.driver_profile === "rabbitmq" || config.driver_profile === "pulsar") {
    return config.driver_profile;
  }
  return "pulsar";
}

export function isFlatMqSystemKind(kind: MqSystemKind | undefined): boolean {
  return kind === "kafka" || kind === "rocketmq" || kind === "rabbitmq";
}

export function defaultMqCapabilitiesForSystemKind(kind: MqSystemKind | undefined): MqCapabilities {
  if (kind === "kafka") {
    return {
      ...FLAT_MQ_BASE_CAPABILITIES,
      supportsRetention: true,
      supportsRateLimits: false,
    };
  }
  if (kind === "rocketmq") {
    return {
      ...FLAT_MQ_BASE_CAPABILITIES,
      supportsMessageQuery: true,
      supportsDlq: true,
      supportsMessageTrace: true,
    };
  }
  if (kind === "rabbitmq") {
    return {
      ...FLAT_MQ_BASE_CAPABILITIES,
      // RabbitMQ is an intermediate form between flat and tenant/namespace systems:
      // namespaces map to virtual hosts (list/create/delete via the management API),
      // and clearing the backlog purges the selected queue.
      supportsNamespaces: true,
      supportsPartitionedTopics: false,
      supportsResetCursor: false,
      supportsPermissions: false,
      // RabbitMQ manages exchanges & bindings on top of queues.
      supportsExchanges: true,
      // Client connections / channels come from the management API.
      supportsClientConnections: true,
      // Users & per-vhost permission triples come from the management API.
      supportsUserPermissions: true,
      // Virtual-host policies come from the management API.
      supportsPolicies: true,
      // Cluster overview & node stats come from the management API.
      supportsClusterMonitoring: true,
    };
  }
  return { ...PULSAR_DEFAULT_CAPABILITIES };
}

/**
 * Synthetic tenant used for RabbitMQ connections. RabbitMQ has no tenant
 * concept; the console pins the tenant to this value and exposes virtual
 * hosts as namespaces instead.
 */
export const RABBITMQ_MQ_TENANT = "_rabbitmq";

/**
 * Marker namespace meaning "all virtual hosts" for RabbitMQ. The backend
 * translates it into a vhost-less management API listing where every item
 * carries its own vhost.
 */
export const RABBITMQ_ALL_VHOSTS = "*";

export function isAllVhostsNamespace(namespace: string | undefined | null): boolean {
  return namespace === RABBITMQ_ALL_VHOSTS;
}

/**
 * Resolve the namespace for a row-level operation: prefer the namespace the
 * row itself carries (cross-vhost listings), falling back to the currently
 * selected namespace. In "all vhosts" mode a row without its own namespace
 * resolves to undefined — "*" is a listing sentinel and must never reach a
 * write operation.
 */
export function resolveMqRowNamespace(row: { namespace?: string } | undefined, selectedNamespace: string | undefined): string | undefined {
  if (row?.namespace) return row.namespace;
  return isAllVhostsNamespace(selectedNamespace) ? undefined : selectedNamespace;
}

/**
 * Resolve the virtual host a RabbitMQ publish targets. A topic chosen from a
 * row keeps its own vhost, then the fallback topic (e.g. the panel's selected
 * topic prop); in all-vhosts mode without a row topic the publish falls back
 * to the connection default vhost (no explicit namespace).
 */
export function resolveRabbitMqSendNamespace(topic: { namespace?: string } | undefined, selectedNamespace: string | undefined, fallbackTopic?: { namespace?: string }): string | undefined {
  const namespace = topic?.namespace || fallbackTopic?.namespace;
  if (namespace) return namespace;
  return isAllVhostsNamespace(selectedNamespace) ? undefined : selectedNamespace;
}

/** Resolve the connection's default virtual host, used as the initial namespace. */
export function resolveRabbitMqDefaultVhost(config: ConnectionConfig | undefined): string {
  const external = config?.external_config as Partial<MqAdminConfig> | undefined;
  const extra = external?.extra as Record<string, unknown> | undefined;
  const vhost = extra?.virtualHost ?? extra?.virtual_host;
  return typeof vhost === "string" && vhost.trim() ? vhost.trim() : "/";
}

export type MqTab = "tenants" | "namespaces" | "topics" | "subscriptions" | "monitoring" | "clients" | "producers" | "policies" | "permissions" | "messages" | "raw" | "broker" | "dlq" | "trace";

export function resolveAvailableMqTabs(options: { systemKind?: MqSystemKind; capabilities: MqCapabilities }): MqTab[] {
  const { systemKind, capabilities } = options;
  if (systemKind === "rocketmq") {
    const tabs: MqTab[] = ["broker", "topics", "subscriptions", "producers"];
    if (capabilities.supportsMessageQuery || capabilities.supportsSendMessage) tabs.push("messages");
    if (capabilities.supportsMessageTrace) tabs.push("trace");
    if (capabilities.supportsPermissions) tabs.push("permissions");
    return tabs;
  }

  const tabs: MqTab[] = [];
  if (capabilities.supportsTenants) tabs.push("tenants");
  if (capabilities.supportsNamespaces) tabs.push("namespaces");
  tabs.push("topics");
  if (capabilities.supportsSubscriptions) tabs.push("subscriptions");
  tabs.push("monitoring");
  tabs.push("clients");
  if (capabilities.supportsSendMessage) tabs.push("messages");
  tabs.push("broker");
  // RabbitMQ lights this tab via virtual-host policies instead of Pulsar rates/quotas.
  if (capabilities.supportsRateLimits || capabilities.supportsBacklogQuota || capabilities.supportsRetention || capabilities.supportsPolicies) {
    tabs.push("policies");
  }
  // RabbitMQ lights this tab via user/vhost permissions instead of role grants.
  if (capabilities.supportsPermissions || capabilities.supportsUserPermissions) tabs.push("permissions");
  if (capabilities.supportsRawAdminApi) tabs.push("raw");
  return tabs;
}

export function normalizeMqTabForSystemKind(tab: MqTab, systemKind?: MqSystemKind): MqTab {
  if (systemKind === "rocketmq" && tab === "dlq") {
    return "messages";
  }
  return tab;
}

export function resolveInitialMqTab(options: { initialTab?: MqTab; initialTenant?: string; systemKind?: MqSystemKind }): MqTab {
  if (options.initialTab) {
    return normalizeMqTabForSystemKind(options.initialTab, options.systemKind);
  }
  if (isFlatMqSystemKind(options.systemKind)) return "topics";
  if (options.initialTenant) return "namespaces";
  return "tenants";
}
