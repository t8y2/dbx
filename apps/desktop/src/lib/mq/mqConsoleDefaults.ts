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
  if (external?.systemKind === "kafka" || external?.systemKind === "rocketmq" || external?.systemKind === "pulsar") {
    return external.systemKind;
  }
  if (config.driver_profile === "kafka" || config.driver_profile === "rocketmq" || config.driver_profile === "pulsar") {
    return config.driver_profile;
  }
  return "pulsar";
}

export function isFlatMqSystemKind(kind: MqSystemKind | undefined): boolean {
  return kind === "kafka" || kind === "rocketmq";
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
  return { ...PULSAR_DEFAULT_CAPABILITIES };
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
  if (capabilities.supportsRateLimits || capabilities.supportsBacklogQuota || capabilities.supportsRetention) {
    tabs.push("policies");
  }
  if (capabilities.supportsPermissions) tabs.push("permissions");
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
