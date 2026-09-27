import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const services = readFileSync(new URL("../ConsulServices.vue", import.meta.url), "utf8");
const health = readFileSync(new URL("../ConsulHealth.vue", import.meta.url), "utf8");
const scope = readFileSync(new URL("../ConsulScope.vue", import.meta.url), "utf8");
const keyBrowser = readFileSync(new URL("../ConsulKeyBrowser.vue", import.meta.url), "utf8");
const mesh = readFileSync(new URL("../ConsulMesh.vue", import.meta.url), "utf8");
const tools = readFileSync(new URL("../ConsulTools.vue", import.meta.url), "utf8");
const operator = readFileSync(new URL("../ConsulOperator.vue", import.meta.url), "utf8");
const kvBrowser = readFileSync(new URL("../../kv/KvKeyBrowser.vue", import.meta.url), "utf8");

describe("Consul Catalog and Health watch views", () => {
  it("renders the complete Enterprise delete impact inventory", () => {
    for (const resource of ["kvKeys", "healthChecks", "sessions", "intentions", "peerings", "aclTokens", "aclPolicies", "aclRoles", "aclAuthMethods", "aclBindingRules"]) {
      expect(scope).toContain(`value.${resource}`);
    }
    expect(scope).toContain("impact.filteredByAcls");
    expect(scope).toContain("impact.unavailableResources");
  });

  it("gates Agent writes on an explicit target that matches the Agent node", () => {
    for (const source of [services, health]) {
      expect(source).toContain("config.agentTarget || config.agent_target");
      expect(source).toContain(':disabled="!canAgentWrite"');
    }
    expect(services).toContain("consulAgentWriteBlockedReason(store.getConfig(props.connectionId), identity.value?.node)");
    expect(services).toContain("const canAgentWrite = computed(() => agentWriteBlockedReason.value === null);");
    expect(health).toContain("consulAgentWriteTargetSafe(store.getConfig(props.connectionId), identity.value?.node)");
  });

  it("marks the specific locked Key and Session in a prefix-delete preview", () => {
    expect(keyBrowser).toContain("'session' in row && row.session ? 'bg-destructive/5' : ''");
    expect(keyBrowser).toContain('v-if="\'session\' in row && row.session" variant="destructive"');
    expect(keyBrowser).toContain('t("consul.ui.sessionValue", { id: row.session })');
  });

  it("opens the safe prefix-delete preview from a Consul directory context menu", () => {
    expect(keyBrowser).toContain(':on-delete-prefix="openDeletePrefix"');
    expect(keyBrowser).toContain('function openDeletePrefix(prefix = "")');
    expect(keyBrowser).not.toContain('@click="openDeletePrefix"');
    expect(kvBrowser).toContain("if (nodeIsExpandable(node) && props.onDeletePrefix)");
    expect(kvBrowser).toContain("action: () => props.onDeletePrefix?.(nodePath(node))");
  });

  it("preserves Exported Services CAS state and capability-gates advanced writes", () => {
    expect(mesh).toContain('consulMeshConfigList(props.connectionId, "exported-services")');
    expect(mesh).toContain("editingExported.value?.modifyIndex || 0");
    expect(tools).toContain("canWriteQueries");
    expect(tools).toContain("canFireEvents");
    expect(operator).toContain("keyringWriteVisible");
    expect(operator).toContain("props.capabilities?.operatorKeyring");
  });
});
