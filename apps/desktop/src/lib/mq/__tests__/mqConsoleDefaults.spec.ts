import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import {
  defaultMqCapabilitiesForSystemKind,
  isAllVhostsNamespace,
  normalizeMqTabForSystemKind,
  RABBITMQ_ALL_VHOSTS,
  resolveAvailableMqTabs,
  resolveInitialMqTab,
  resolveMqRowNamespace,
  resolveMqSystemKindFromConnection,
  resolveRabbitMqDefaultVhost,
  resolveRabbitMqSendNamespace,
} from "@/lib/mq/mqConsoleDefaults";

describe("mqConsoleDefaults", () => {
  it("resolves RocketMQ from driver profile before cluster info loads", () => {
    const config = {
      id: "mq-1",
      db_type: "mq",
      driver_profile: "rocketmq",
      external_config: { systemKind: "rocketmq", adminUrl: "", auth: { kind: "none" } },
    } as ConnectionConfig;

    expect(resolveMqSystemKindFromConnection(config)).toBe("rocketmq");
    expect(defaultMqCapabilitiesForSystemKind("rocketmq").supportsTenants).toBe(false);
    expect(defaultMqCapabilitiesForSystemKind("rocketmq").supportsNamespaces).toBe(false);
  });

  it("opens flat MQ consoles on the topics tab", () => {
    expect(resolveInitialMqTab({ systemKind: "rocketmq", initialTenant: "_flat_mq" })).toBe("topics");
    expect(resolveInitialMqTab({ systemKind: "pulsar" })).toBe("tenants");
    expect(resolveInitialMqTab({ systemKind: "pulsar", initialTenant: "public" })).toBe("namespaces");
  });

  it("falls back dlq tab to messages for RocketMQ", () => {
    expect(normalizeMqTabForSystemKind("dlq", "rocketmq")).toBe("messages");
    expect(normalizeMqTabForSystemKind("trace", "rocketmq")).toBe("trace");
    expect(normalizeMqTabForSystemKind("trace", "pulsar")).toBe("trace");
    expect(resolveInitialMqTab({ systemKind: "rocketmq", initialTab: "dlq" })).toBe("messages");
    expect(resolveInitialMqTab({ systemKind: "rocketmq", initialTab: "trace" })).toBe("trace");
  });

  it("exposes RocketMQ tabs including trace but not dlq", () => {
    const caps = defaultMqCapabilitiesForSystemKind("rocketmq");
    expect(resolveAvailableMqTabs({ systemKind: "rocketmq", capabilities: caps })).toEqual(["broker", "topics", "subscriptions", "producers", "messages", "trace", "permissions"]);
  });

  it("resolves RabbitMQ from driver profile and external config", () => {
    const config = {
      id: "mq-2",
      db_type: "mq",
      driver_profile: "rabbitmq",
      external_config: { systemKind: "rabbitmq", adminUrl: "", auth: { kind: "none" } },
    } as ConnectionConfig;

    expect(resolveMqSystemKindFromConnection(config)).toBe("rabbitmq");
    expect(resolveMqSystemKindFromConnection({ ...config, external_config: undefined })).toBe("rabbitmq");
  });

  it("treats RabbitMQ as a flat MQ system with vhost namespaces", () => {
    const caps = defaultMqCapabilitiesForSystemKind("rabbitmq");
    expect(caps.supportsTenants).toBe(false);
    expect(caps.supportsNamespaces).toBe(true);
    expect(caps.supportsPartitionedTopics).toBe(false);
    expect(caps.supportsClearBacklog).toBe(true);
    expect(caps.supportsSubscriptions).toBe(true);
    expect(caps.supportsPeekMessages).toBe(true);
    expect(caps.supportsSendMessage).toBe(true);
    expect(resolveInitialMqTab({ systemKind: "rabbitmq", initialTenant: "_flat_mq" })).toBe("topics");
  });

  it("enables client connection management for RabbitMQ only", () => {
    expect(defaultMqCapabilitiesForSystemKind("rabbitmq").supportsClientConnections).toBe(true);
    expect(defaultMqCapabilitiesForSystemKind("kafka").supportsClientConnections).toBe(false);
    expect(defaultMqCapabilitiesForSystemKind("rocketmq").supportsClientConnections).toBe(false);
    expect(defaultMqCapabilitiesForSystemKind("pulsar").supportsClientConnections).toBeFalsy();
  });

  it("exposes the namespaces tab for RabbitMQ vhost management", () => {
    const caps = defaultMqCapabilitiesForSystemKind("rabbitmq");
    expect(resolveAvailableMqTabs({ systemKind: "rabbitmq", capabilities: caps })).toEqual(["namespaces", "topics", "subscriptions", "monitoring", "clients", "messages", "broker", "policies", "permissions"]);
  });

  it("enables policies & cluster monitoring for RabbitMQ only", () => {
    expect(defaultMqCapabilitiesForSystemKind("rabbitmq").supportsPolicies).toBe(true);
    expect(defaultMqCapabilitiesForSystemKind("rabbitmq").supportsClusterMonitoring).toBe(true);
    expect(defaultMqCapabilitiesForSystemKind("kafka").supportsPolicies).toBeFalsy();
    expect(defaultMqCapabilitiesForSystemKind("kafka").supportsClusterMonitoring).toBeFalsy();
    expect(defaultMqCapabilitiesForSystemKind("rocketmq").supportsPolicies).toBeFalsy();
    expect(defaultMqCapabilitiesForSystemKind("pulsar").supportsPolicies).toBeFalsy();
  });

  it("lights the policies tab via supportsPolicies for RabbitMQ", () => {
    const caps = defaultMqCapabilitiesForSystemKind("rabbitmq");
    expect(caps.supportsRateLimits).toBe(false);
    expect(caps.supportsBacklogQuota).toBe(false);
    expect(caps.supportsRetention).toBe(false);

    // The tab appears even when Pulsar-style rates/quotas are unsupported.
    const rabbitTabs = resolveAvailableMqTabs({ systemKind: "rabbitmq", capabilities: { ...caps, supportsPolicies: true } });
    expect(rabbitTabs).toContain("policies");

    // Without any policy capability the tab stays hidden.
    const noPolicyCaps = { ...defaultMqCapabilitiesForSystemKind("kafka"), supportsRetention: false, supportsPolicies: false };
    expect(resolveAvailableMqTabs({ systemKind: "kafka", capabilities: noPolicyCaps })).not.toContain("policies");
  });

  it("lights the permissions tab via supportsUserPermissions for RabbitMQ", () => {
    const caps = defaultMqCapabilitiesForSystemKind("rabbitmq");
    expect(caps.supportsPermissions).toBe(false);
    expect(caps.supportsUserPermissions).toBe(true);
    expect(defaultMqCapabilitiesForSystemKind("kafka").supportsUserPermissions).toBeFalsy();
    expect(defaultMqCapabilitiesForSystemKind("pulsar").supportsUserPermissions).toBeFalsy();

    // The tab appears even when role-grant permissions are unsupported.
    const rabbitTabs = resolveAvailableMqTabs({ systemKind: "rabbitmq", capabilities: { ...caps, supportsPermissions: false, supportsUserPermissions: true } });
    expect(rabbitTabs).toContain("permissions");

    // Without either capability the tab stays hidden.
    const noPermCaps = { ...defaultMqCapabilitiesForSystemKind("kafka"), supportsPermissions: false, supportsUserPermissions: false };
    expect(resolveAvailableMqTabs({ systemKind: "kafka", capabilities: noPermCaps })).not.toContain("permissions");
  });

  it("resolves the RabbitMQ default vhost from the connection config", () => {
    expect(resolveRabbitMqDefaultVhost(undefined)).toBe("/");
    expect(resolveRabbitMqDefaultVhost({ id: "mq-3", db_type: "mq" } as ConnectionConfig)).toBe("/");
    const config = {
      id: "mq-3",
      db_type: "mq",
      driver_profile: "rabbitmq",
      external_config: { systemKind: "rabbitmq", adminUrl: "", auth: { kind: "none" }, extra: { virtualHost: "orders" } },
    } as ConnectionConfig;
    expect(resolveRabbitMqDefaultVhost(config)).toBe("orders");
    const snakeCase = {
      ...config,
      external_config: { systemKind: "rabbitmq", adminUrl: "", auth: { kind: "none" }, extra: { virtual_host: "billing" } },
    } as ConnectionConfig;
    expect(resolveRabbitMqDefaultVhost(snakeCase)).toBe("billing");
  });

  it('marks the all-vhosts selection with the "*" namespace', () => {
    expect(RABBITMQ_ALL_VHOSTS).toBe("*");
    expect(isAllVhostsNamespace("*")).toBe(true);
    expect(isAllVhostsNamespace("/")).toBe(false);
    expect(isAllVhostsNamespace("orders")).toBe(false);
    expect(isAllVhostsNamespace(undefined)).toBe(false);
    expect(isAllVhostsNamespace(null)).toBe(false);
  });

  it("routes row-level operations to the row vhost with selection fallback", () => {
    expect(resolveMqRowNamespace({ namespace: "orders" }, "*")).toBe("orders");
    expect(resolveMqRowNamespace({ namespace: "orders" }, "/")).toBe("orders");
    expect(resolveMqRowNamespace({}, "/")).toBe("/");
    expect(resolveMqRowNamespace(undefined, "/")).toBe("/");
    expect(resolveMqRowNamespace(undefined, undefined)).toBeUndefined();
  });

  it("never falls back to the all-vhosts sentinel for row-level operations", () => {
    // "*" is a listing sentinel: a row without its own vhost must not resolve
    // to it, otherwise a write would fan out across every vhost.
    expect(resolveMqRowNamespace({}, "*")).toBeUndefined();
    expect(resolveMqRowNamespace(undefined, "*")).toBeUndefined();
  });

  it("publishes to the row vhost or the connection default in all-vhosts mode", () => {
    // A topic entered from a cross-vhost row keeps its own vhost.
    expect(resolveRabbitMqSendNamespace({ namespace: "orders" }, "*")).toBe("orders");
    expect(resolveRabbitMqSendNamespace({ namespace: "orders" }, "/")).toBe("orders");
    // All-vhosts mode without a row topic falls back to the connection default vhost.
    expect(resolveRabbitMqSendNamespace(undefined, "*")).toBeUndefined();
    expect(resolveRabbitMqSendNamespace({}, "*")).toBeUndefined();
    // Single-vhost mode keeps the selected namespace.
    expect(resolveRabbitMqSendNamespace(undefined, "/")).toBe("/");
  });

  it("prefers the datalist row vhost, then the fallback topic, when publishing", () => {
    // The datalist row (picked/typed topic) wins over the panel's topic prop.
    expect(resolveRabbitMqSendNamespace({ namespace: "orders" }, "*", { namespace: "billing" })).toBe("orders");
    // Without a datalist row the fallback topic's vhost is used, even in all-vhosts mode.
    expect(resolveRabbitMqSendNamespace(undefined, "*", { namespace: "billing" })).toBe("billing");
    expect(resolveRabbitMqSendNamespace({}, "*", { namespace: "billing" })).toBe("billing");
    // The fallback topic also wins over a single-vhost selection.
    expect(resolveRabbitMqSendNamespace(undefined, "/", { namespace: "billing" })).toBe("billing");
    // Nothing to go on in all-vhosts mode: fall back to the connection default vhost.
    expect(resolveRabbitMqSendNamespace(undefined, "*", undefined)).toBeUndefined();
  });
});
