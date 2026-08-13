import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../NacosAccessControlConsole.vue", import.meta.url), "utf8");
const legacySource = readFileSync(new URL("../NacosAccessControl.vue", import.meta.url), "utf8");
const treeItemSource = readFileSync(new URL("../../sidebar/TreeItem.vue", import.meta.url), "utf8");
const connectionTreeSource = readFileSync(new URL("../../sidebar/ConnectionTree.vue", import.meta.url), "utf8");
const connectionStoreSource = readFileSync(new URL("../../../stores/connectionStore.ts", import.meta.url), "utf8");

describe("NacosAccessControlConsole", () => {
  it("uses the access-control header pattern for its navigation", () => {
    expect(source).toContain('class="flex h-14 shrink-0 flex-wrap items-center gap-3 border-b px-4"');
    expect(source).toContain('class="flex rounded-md border p-0.5 shadow-sm"');
    expect(source).toContain("<UsersRound");
    expect(source).toContain("<KeyRound");
    expect(source).toContain('t("nacos.accessControlTitle")');
    expect(source).toContain('t("nacos.accessControlDescription")');
  });

  it("only submits r-nacos namespace privilege fields supported by its API", () => {
    expect(legacySource).not.toContain("privilegeEnabled");
    expect(legacySource).toContain("whitelistIsAll: userForm.value.whitelistIsAll");
    expect(legacySource).toContain("blacklistIsAll: userForm.value.blacklistIsAll");
    expect(legacySource).toContain('import NacosNamespaceMultiSelect from "@/components/nacos/NacosNamespaceMultiSelect.vue"');
    expect(legacySource).toContain('v-model="userForm.whitelist"');
    expect(legacySource).toContain('v-model="userForm.blacklist"');
    expect(legacySource).toContain("whitelist: [...userForm.value.whitelist]");
    expect(legacySource).toContain("blacklist: [...userForm.value.blacklist]");
    expect(legacySource).not.toContain('<textarea v-model="userForm.whitelist"');
    expect(legacySource).not.toContain('<textarea v-model="userForm.blacklist"');
  });

  it("switches tabs when navigating between associated users and roles", () => {
    expect(source).toContain("@select-user=\"activeTab = 'users'\"");
    expect(source).toContain("@select-role=\"activeTab = 'roles'\"");
  });

  it("shares the directory-detail workspace across supported Nacos versions", () => {
    expect(source).toContain('import NacosRoleAccessControl from "@/components/nacos/NacosRoleAccessControl.vue"');
    expect(source).toContain('<NacosRoleAccessControl v-if="enhancedWorkspace"');
  });

  it("internationalizes the sidebar entry, including trees persisted with the old label", () => {
    expect(connectionStoreSource).toContain('label: "nacos.accessControlSidebarLabel"');
    expect(treeItemSource).toContain('if (node.type === "nacos-access-control") return t("nacos.accessControlSidebarLabel")');
    expect(connectionTreeSource).toContain('node.type === "nacos-access-control" ? t("nacos.accessControlSidebarLabel") : node.label');
  });
});
