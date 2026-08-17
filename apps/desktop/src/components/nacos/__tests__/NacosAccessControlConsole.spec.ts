/** @vitest-environment happy-dom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NacosConnectionInfo } from "@/types/nacos";

const mocks = vi.hoisted(() => ({
  connectionInfo: null as NacosConnectionInfo | null,
  ensureConnected: vi.fn(async () => undefined),
}));

vi.mock("@/lib/backend/api", () => ({
  nacosTestConnection: vi.fn(async () => {
    if (!mocks.connectionInfo) throw new Error("missing Nacos connection fixture");
    return mocks.connectionInfo;
  }),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ ensureConnected: mocks.ensureConnected }),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/nacos/NacosAccessControl.vue", async () => {
  const { h } = await import("vue");
  return {
    default: {
      props: ["tab"],
      setup: (props: { tab: string }) => () => h("div", { "data-testid": "nacos-access-control-workspace", "data-tab": props.tab }),
    },
  };
});

vi.mock("@/components/nacos/NacosRoleAccessControl.vue", async () => {
  const { h } = await import("vue");
  return {
    default: {
      props: ["capabilities"],
      setup: (props: { capabilities: { createUser: { supported: boolean } } }) => () =>
        h("div", {
          "data-testid": "nacos-role-access-control-workspace",
          "data-can-create-user": String(props.capabilities.createUser.supported),
        }),
    },
  };
});

import NacosAccessControlConsole from "../NacosAccessControlConsole.vue";

const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/nacos/NacosAccessControlConsole.vue"), "utf8");
const legacySource = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/nacos/NacosAccessControl.vue"), "utf8");
const treeItemSource = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/sidebar/TreeItem.vue"), "utf8");
const connectionTreeSource = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/sidebar/ConnectionTree.vue"), "utf8");
const connectionStoreSource = readFileSync(resolve(process.cwd(), "apps/desktop/src/stores/connectionStore.ts"), "utf8");
const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  mocks.connectionInfo = null;
  vi.clearAllMocks();
});

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

  it("keeps the roles-only workspace reachable without an unavailable banner", () => {
    expect(source).toContain('if (!supportsUsers.value && supportsRoles.value) activeTab.value = "roles"');
    expect(source).toContain('v-if="!supportsUsers && !supportsRoles"');
    expect(connectionStoreSource).toContain("sidebarSnapshot.accessControl.listUsers.supported === true ||");
    expect(connectionStoreSource).toContain("sidebarSnapshot.accessControl.listRoleBindings.supported === true");
  });

  it("keeps the roles-only workspace visible alongside the permission warning", async () => {
    const unsupported = { supported: false, reason: "permissionDenied" as const };
    mocks.connectionInfo = {
      serverAddr: "http://127.0.0.1:8848",
      displayServerAddr: "http://127.0.0.1:8848",
      namespace: "",
      auth: "usernamePassword",
      capabilities: {
        supportsConfigManagement: true,
        supportsServiceManagement: true,
        supportsInstanceUpdate: true,
        supportsRawApi: true,
        accessControl: {
          mode: "roleBindings",
          listUsers: unsupported,
          createUser: unsupported,
          updateUser: unsupported,
          deleteUser: unsupported,
          listRoleBindings: { supported: true },
          assignRole: unsupported,
          removeRole: unsupported,
          listPermissions: unsupported,
          grantPermission: unsupported,
          revokePermission: unsupported,
          enhancedWorkspace: false,
          supportsNamespacePrivileges: false,
        },
      },
    };

    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(NacosAccessControlConsole, { connectionId: "nacos-1" });
    mountedApps.push({ app, host });
    app.mount(host);
    await settle();

    expect(host.textContent).toContain("nacos.accessPermissionEndpointUnavailable");
    const workspace = host.querySelector('[data-testid="nacos-access-control-workspace"]');
    expect(workspace).not.toBeNull();
    expect(workspace?.getAttribute("data-tab")).toBe("roles");
  });

  it("shares the directory-detail workspace across supported Nacos versions", () => {
    expect(source).toContain('import NacosRoleAccessControl from "@/components/nacos/NacosRoleAccessControl.vue"');
    expect(source).toContain('<NacosRoleAccessControl v-if="enhancedWorkspace && accessControl"');
    expect(source).toContain(':capabilities="accessControl"');
  });

  it("keeps the enhanced read workspace visible when writes are permission denied", async () => {
    const unsupported = { supported: false, reason: "permissionDenied" as const };
    const supported = { supported: true };
    mocks.connectionInfo = {
      serverAddr: "http://127.0.0.1:8848",
      displayServerAddr: "http://127.0.0.1:8848",
      namespace: "",
      auth: "usernamePassword",
      capabilities: {
        supportsConfigManagement: true,
        supportsServiceManagement: true,
        supportsInstanceUpdate: true,
        supportsRawApi: true,
        accessControl: {
          mode: "roleBindings",
          listUsers: supported,
          createUser: unsupported,
          updateUser: unsupported,
          deleteUser: unsupported,
          listRoleBindings: supported,
          assignRole: unsupported,
          removeRole: unsupported,
          listPermissions: supported,
          grantPermission: unsupported,
          revokePermission: unsupported,
          enhancedWorkspace: true,
          supportsNamespacePrivileges: false,
        },
      },
    };

    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(NacosAccessControlConsole, { connectionId: "nacos-read-only" });
    mountedApps.push({ app, host });
    app.mount(host);
    await settle();

    const workspace = host.querySelector('[data-testid="nacos-role-access-control-workspace"]');
    expect(workspace).not.toBeNull();
    expect(workspace?.getAttribute("data-can-create-user")).toBe("false");
  });

  it("internationalizes the sidebar entry, including trees persisted with the old label", () => {
    expect(connectionStoreSource).toContain('label: "nacos.accessControlSidebarLabel"');
    expect(treeItemSource).toContain('if (node.type === "nacos-access-control") return t("nacos.accessControlSidebarLabel")');
    expect(connectionTreeSource).toContain('node.type === "nacos-access-control" ? t("nacos.accessControlSidebarLabel") : node.label');
  });
});
