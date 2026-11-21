import { describe, expect, it } from "vitest";
import { cloneResultProtectionScope, createMcpResultProtectionPolicy, effectiveResultProtection, localResultProtectionSettings, prepareResultProtectionPolicy, removeResultProtectionScope, resultProtectionTemplate } from "@/lib/mcp/mcpResultProtection";
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

  it("resolves database, connection, nearest group and global without merging rules", () => {
    const policy = createMcpResultProtectionPolicy();
    const settings = (id: string, enabled = true) => ({ enabled, mode: "strict" as const, rules: [{ ...resultProtectionTemplate()[0], id }] });
    policy.default = settings("global");
    policy.groupOverrides = [
      { groupId: "parent", settings: settings("parent") },
      { groupId: "child", settings: settings("child", false) },
    ];
    const context = { connectionId: "connection", database: "app", groupIds: ["parent", "child"] };
    expect(effectiveResultProtection(policy, context)).toEqual({ settings: settings("child", false), source: { kind: "group", groupId: "child" } });
    policy.overrides.push({ connectionId: "connection", database: null, settings: settings("connection") });
    expect(effectiveResultProtection(policy, context).settings.rules.map((rule) => rule.id)).toEqual(["connection"]);
    policy.overrides.push({ connectionId: "connection", database: "app", settings: settings("database", false) });
    expect(effectiveResultProtection(policy, context)).toEqual({ settings: settings("database", false), source: { kind: "database", connectionId: "connection", database: "app" } });
    expect(effectiveResultProtection(policy, { groupIds: ["parent", "unknown"] }).source).toEqual({ kind: "group", groupId: "parent" });
    expect(effectiveResultProtection(policy, {}).source).toEqual({ kind: "global" });
  });

  it("clones the effective parent including off state and restores inheritance without changing the parent", () => {
    const policy = createMcpResultProtectionPolicy();
    policy.groupOverrides = [{ groupId: "group", settings: { enabled: false, mode: "nameOnly", rules: resultProtectionTemplate() } }];
    const scope = { kind: "connection" as const, connectionId: "connection" };
    const local = cloneResultProtectionScope(policy, scope, ["group"]);
    expect(local).toEqual(policy.groupOverrides[0].settings);
    local.rules[0].id = "local";
    expect(policy.groupOverrides[0].settings.rules[0].id).toBe("credentials");
    expect(localResultProtectionSettings(policy, scope)?.enabled).toBe(false);
    removeResultProtectionScope(policy, scope);
    expect(localResultProtectionSettings(policy, scope)).toBeUndefined();
    expect(effectiveResultProtection(policy, { connectionId: "connection", groupIds: ["group"] }).source).toEqual({ kind: "group", groupId: "group" });
  });

  it("normalizes legacy policies and includes group rules when generating a hash key", () => {
    const policy = createMcpResultProtectionPolicy();
    delete (policy as Partial<typeof policy>).groupOverrides;
    expect(prepareResultProtectionPolicy(policy).groupOverrides).toEqual([]);
    expect(normalizeMcpGlobalPolicy({ resultProtection: policy }).resultProtection.groupOverrides).toEqual([]);
    policy.groupOverrides = [{ groupId: "group", settings: { enabled: false, mode: "strict", rules: [{ ...resultProtectionTemplate()[0], action: "hash" }] } }];
    expect(prepareResultProtectionPolicy(policy).hashKey).toMatch(/^[a-f0-9]{64}$/);
  });
});
