import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import { defaultMqCapabilitiesForSystemKind, normalizeMqTabForSystemKind, resolveAvailableMqTabs, resolveInitialMqTab, resolveMqSystemKindFromConnection } from "@/lib/mq/mqConsoleDefaults";

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
});
