/** @vitest-environment happy-dom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NacosConnectionInfo } from "@/types/nacos";

const mocks = vi.hoisted(() => ({
  connectionInfo: null as NacosConnectionInfo | null,
  ensureConnected: vi.fn(async () => undefined),
  refreshLegacyWorkspace: vi.fn(async () => undefined),
  refreshEnhancedWorkspace: vi.fn(async () => undefined),
  nacosTestConnection: vi.fn(async () => {
    if (!mocks.connectionInfo) throw new Error("missing Nacos connection fixture");
    return mocks.connectionInfo;
  }),
}));

vi.mock("@/lib/backend/api", () => ({
  nacosTestConnection: (...args: unknown[]) => mocks.nacosTestConnection(...args),
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
      setup: (props: { tab: string }, { expose }: { expose: (value: { refresh: () => Promise<void> }) => void }) => {
        expose({ refresh: mocks.refreshLegacyWorkspace });
        return () => h("div", { "data-testid": "nacos-access-control-workspace", "data-tab": props.tab });
      },
    },
  };
});

vi.mock("@/components/nacos/NacosRoleAccessControl.vue", async () => {
  const { h } = await import("vue");
  return {
    default: {
      props: ["capabilities"],
      setup: (props: { capabilities: { createUser: { supported: boolean } } }, { expose }: { expose: (value: { refresh: () => Promise<void> }) => void }) => {
        expose({ refresh: mocks.refreshEnhancedWorkspace });
        return () =>
          h("div", {
            "data-testid": "nacos-role-access-control-workspace",
            "data-can-create-user": String(props.capabilities.createUser.supported),
          });
      },
    },
  };
});

import NacosAccessControlConsole from "../NacosAccessControlConsole.vue";

const legacySource = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/nacos/NacosAccessControl.vue"), "utf8");
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
  it("requires exact username confirmation before deleting a user in the legacy workspace", () => {
    expect(legacySource).toContain("const userDeleteConfirmed = computed(() => userDeleteConfirmation.value === pendingUserDelete.value?.username)");
    expect(legacySource).toContain('@click="openDeleteUser(user)"');
    expect(legacySource).toContain('t("nacos.accessDeleteUserConfirmationLabel")');
    expect(legacySource).toContain(':disabled="deletingUser || !userDeleteConfirmed"');
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

  it("refreshes the enhanced workspace snapshot after refreshing connection capabilities", async () => {
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
          createUser: supported,
          updateUser: supported,
          deleteUser: supported,
          listRoleBindings: supported,
          assignRole: supported,
          removeRole: supported,
          listPermissions: supported,
          grantPermission: supported,
          revokePermission: supported,
          enhancedWorkspace: true,
          supportsNamespacePrivileges: false,
        },
      },
    };

    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(NacosAccessControlConsole, { connectionId: "nacos-refresh" });
    mountedApps.push({ app, host });
    app.mount(host);
    await settle();
    mocks.refreshEnhancedWorkspace.mockClear();

    const refreshButton = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("nacos.refresh"));
    expect(refreshButton).toBeDefined();
    refreshButton?.click();
    await settle();

    expect(mocks.nacosTestConnection).toHaveBeenLastCalledWith("nacos-refresh", true);
    expect(mocks.refreshEnhancedWorkspace).toHaveBeenCalledTimes(1);
  });
});
