import { describe, expect, it } from "vitest";
import { defaultMqCapabilitiesForSystemKind, resolveAvailableMqTabs } from "../mqConsoleDefaults";

describe("RocketMQ explicit administration capabilities", () => {
  it("keeps the legacy administration tabs when optional flags are absent", () => {
    expect(resolveAvailableMqTabs({ systemKind: "rocketmq", capabilities: defaultMqCapabilitiesForSystemKind("rocketmq") })).toContain("broker");
  });
  it("uses conservative capabilities for a configured proxy before negotiation", () => {
    const config = { db_type: "mq", driver_profile: "rocketmq", external_config: { systemKind: "rocketmq", extra: { connectionMode: "proxy" } } } as import("@/types/database").ConnectionConfig;
    const capabilities = defaultMqCapabilitiesForSystemKind("rocketmq", config);
    expect(resolveAvailableMqTabs({ systemKind: "rocketmq", capabilities })).toEqual(["messages"]);
    expect(capabilities.supportsPeekMessages).toBe(false);
    expect(capabilities.supportsMessageQuery).toBe(false);
  });
  it("exposes only sending when administration is unavailable", () => {
    const capabilities = { ...defaultMqCapabilitiesForSystemKind("rocketmq"), supportsListTopics: false, supportsBrokerAdmin: false, supportsProducerListing: false, supportsSubscriptions: false, supportsMessageQuery: false, supportsMessageTrace: false, supportsPermissions: false };
    expect(resolveAvailableMqTabs({ systemKind: "rocketmq", capabilities })).toEqual(["messages"]);
  });
});
