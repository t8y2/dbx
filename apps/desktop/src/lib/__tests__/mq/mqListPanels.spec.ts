import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function componentSource(name: string): string {
  return readFileSync(new URL(`../../../components/mq/${name}`, import.meta.url), "utf8");
}

describe("MQ list panels", () => {
  it("does not issue per-tenant detail requests from the tenant list UI", () => {
    const source = componentSource("TenantsPanel.vue");

    expect(source).not.toContain("mqGetTenant");
  });

  it("does not issue per-namespace permission requests from the namespace list UI", () => {
    const source = componentSource("NamespacesPanel.vue");

    expect(source).not.toContain("mqListPermissions");
  });

  it("refreshing policies hydrates missing fields from defaults instead of dirty form values", () => {
    const source = componentSource("PoliciesPanel.vue");

    expect(source).not.toContain("policyFormsFromEffectivePolicies(loaded, currentPolicyForms())");
    expect(source).toContain("policyFormsFromEffectivePolicies(loaded, defaultMqPolicyForms())");
  });

  it("raw api panel includes common endpoint presets that use the selected mq context", () => {
    const rawSource = componentSource("RawApiPanel.vue");
    const consoleSource = componentSource("MqAdminConsole.vue");

    expect(rawSource).toContain("const presets = computed<RawApiPreset[]>");
    expect(rawSource).toContain("/admin/v2/brokers/version");
    expect(rawSource).toContain("/internalStats");
    expect(rawSource).toContain("/partitioned-stats");
    expect(rawSource).toContain("/schema");
    expect(rawSource).toContain("presetsCollapsed");
    expect(rawSource).toContain("formatJsonBody");
    expect(rawSource).toContain("bodyTextareaRows");
    expect(rawSource).toContain("body: isReadMethod.value ? undefined : parseBody()");
    expect(consoleSource).toContain(':tenant="selectedTenant"');
    expect(consoleSource).toContain(':namespace="selectedNamespace"');
    expect(consoleSource).toContain(':topic="selectedTopic"');
  });
});
