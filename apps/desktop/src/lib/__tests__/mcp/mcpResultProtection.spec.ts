import { describe, expect, it } from "vitest";
import { createMcpResultProtectionPolicy, prepareResultProtectionPolicy, resultProtectionTemplate } from "@/lib/mcp/mcpResultProtection";
import { normalizeMcpGlobalPolicy } from "@/stores/settingsStore";

describe("MCP result protection configuration", () => {
  it("keeps templates opt-in and makes independent editable copies", () => {
    const first = createMcpResultProtectionPolicy();
    first.default.rules = resultProtectionTemplate();
    first.default.rules[0].action = "deny";
    expect(first.default.enabled).toBe(false);
    expect(createMcpResultProtectionPolicy().default.rules).toEqual([]);
    expect(resultProtectionTemplate()[0].action).toBe("remove");
  });

  it("generates a stable private hash key only when needed", () => {
    const policy = createMcpResultProtectionPolicy();
    policy.default.rules = resultProtectionTemplate();
    expect(prepareResultProtectionPolicy(policy).hashKey).toBeNull();
    policy.default.rules[1].action = "hash";
    const prepared = prepareResultProtectionPolicy(policy);
    expect(prepared.hashKey).toMatch(/^[a-f0-9]{64}$/);
    expect(prepareResultProtectionPolicy(prepared).hashKey).toBe(prepared.hashKey);
    expect(policy.hashKey).toBeNull();
  });

  it("preserves protection, overrides and hash identity while normalizing other permissions", () => {
    const policy = createMcpResultProtectionPolicy();
    policy.default = { enabled: true, mode: "strict", rules: resultProtectionTemplate() };
    policy.overrides = [{ connectionId: "connection", database: "private", settings: { ...policy.default, mode: "nameOnly" } }];
    policy.hashKey = "persistent-private-key";
    const normalized = normalizeMcpGlobalPolicy({ resultProtection: policy, readOnly: true, allowedConnectionIds: [" connection "] });
    expect(normalized.resultProtection).toEqual(policy);
    expect(normalized.allowedConnectionIds).toEqual(["connection"]);
    expect(normalized.readOnly).toBe(true);
  });
});
