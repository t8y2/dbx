/** @vitest-environment happy-dom */

import { createApp, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listQueries: vi.fn(async () => []),
  updateConnection: vi.fn(async () => undefined),
}));

function mockWorkspaceChild(refresh = vi.fn(() => true)) {
  return {
    __esModule: true,
    default: {
      setup(_props: unknown, { expose }: { expose: (value: { refresh: () => boolean }) => void }) {
        expose({ refresh });
        return () => "mock-consul-child";
      },
    },
  };
}

vi.mock("@/components/consul/ConsulKeyBrowser.vue", () => mockWorkspaceChild());
vi.mock("@/components/consul/ConsulServices.vue", () => mockWorkspaceChild());
vi.mock("@/components/consul/ConsulHealth.vue", () => mockWorkspaceChild());
vi.mock("@/components/consul/ConsulSessions.vue", () => mockWorkspaceChild());
vi.mock("@/components/consul/ConsulAcl.vue", () => mockWorkspaceChild());
vi.mock("@/components/consul/ConsulScope.vue", () => mockWorkspaceChild());
vi.mock("@/components/consul/ConsulMesh.vue", () => mockWorkspaceChild());
vi.mock("@/components/consul/ConsulOperator.vue", () => mockWorkspaceChild());

vi.mock("@/lib/backend/api", () => ({
  consulCapabilities: vi.fn(async () => ({
    acl: "supported",
    authMethods: "supported",
    bindingRules: "supported",
    templatedPolicies: "supported",
    namespaces: "supported",
    partitions: "supported",
    configEntries: "supported",
    intentions: "supported",
    peering: "supported",
    exportedServices: "supported",
    preparedQueries: "supported",
    events: "supported",
    coordinates: "supported",
    operatorAutopilot: "supported",
    operatorRaft: "supported",
    operatorKeyring: "supported",
    operatorUsage: "supported",
    operatorLicense: "supported",
    audit: "supported",
    datacenter: "dc1",
  })),
  consulCatalogDatacenters: vi.fn(async () => ["dc1", "dc2"]),
  consulPreparedQueryList: mocks.listQueries,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => ({
      id: "connection-1",
      external_config: { datacenter: "dc1", consulMeshVisible: true, consulOperatorVisible: true },
    }),
    updateConnection: mocks.updateConnection,
  }),
}));

vi.mock("@/stores/consulStore", () => ({
  useConsulStore: () => ({ bindConnection: vi.fn(), switchScope: vi.fn() }),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import ConsulWorkspace from "../ConsulWorkspace.vue";

const mountedApps: Array<{ unmount: () => void; host: HTMLElement }> = [];

async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

afterEach(() => {
  for (const { unmount, host } of mountedApps.splice(0)) {
    unmount();
    host.remove();
  }
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("ConsulWorkspace interactions", () => {
  it("renders a working datacenter selector when multiple datacenters are available", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(ConsulWorkspace, { connectionId: "connection-1" });
    app.mount(host);
    mountedApps.push({ unmount: () => app.unmount(), host });
    await settle();

    const scopeButton = Array.from(host.querySelectorAll("button")).find((button) => button.title === "consul.ui.scope");
    expect(scopeButton).toBeTruthy();
    scopeButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();

    expect(document.body.querySelector('[role="combobox"]')).toBeTruthy();
    expect(document.body.textContent).toContain("dc1");
  });

  it("routes the global refresh action to the active tools tab", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(ConsulWorkspace, { connectionId: "connection-1" });
    app.mount(host);
    mountedApps.push({ unmount: () => app.unmount(), host });
    await settle();

    const toolsTab = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.trim() === "consul.workspace.tools");
    expect(toolsTab).toBeTruthy();
    toolsTab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    await settle();
    expect(toolsTab!.getAttribute("aria-selected")).toBe("true");
    await vi.waitFor(() => expect(mocks.listQueries).toHaveBeenCalled());
    mocks.listQueries.mockClear();

    const refreshButton = Array.from(host.querySelectorAll("button")).find((button) => button.title === "consul.ui.refresh");
    expect(refreshButton).toBeTruthy();
    refreshButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(mocks.listQueries).toHaveBeenCalledTimes(1));
  });
});
