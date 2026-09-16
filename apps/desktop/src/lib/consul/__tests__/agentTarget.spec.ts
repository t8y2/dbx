import { describe, expect, it } from "vitest";
import { consulAgentAddressesMatch, consulAgentWriteTargetSafe } from "../agentTarget";

describe("Consul Agent target safety", () => {
  it("treats loopback aliases as equivalent", () => {
    expect(consulAgentAddressesMatch("localhost", "127.0.0.1")).toBe(true);
    expect(consulAgentAddressesMatch("::1", "localhost")).toBe(true);
  });

  it("rejects DNS and Transport targets in the UI gate", () => {
    const target = { agentTarget: { node: "node-1", address: "127.0.0.1" } };
    expect(consulAgentWriteTargetSafe({ external_config: { ...target, serverAddr: "https://consul.example" } }, "node-1")).toBe(false);
    expect(consulAgentWriteTargetSafe({ transport_layers: [{}], external_config: { ...target, serverAddr: "http://127.0.0.1:8500" } }, "node-1")).toBe(false);
    expect(consulAgentWriteTargetSafe({ external_config: { ...target, serverAddr: "http://localhost:8500" } }, "node-1")).toBe(true);
  });
});
