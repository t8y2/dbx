/** @vitest-environment happy-dom */

import { createApp, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const agentChecks: Record<string, Record<string, unknown>> = {};
  return {
    connectionConfig: { base_url: "http://127.0.0.1:8500", external_config: {} } as Record<string, unknown>,
    agentChecks,
    serviceMaintenance: vi.fn(async (_connectionId: string, id: string, enable: boolean) => {
      const checkId = `_service_maintenance:${id}`;
      if (enable) {
        agentChecks[checkId] = {
          Node: "node-1",
          CheckID: checkId,
          Name: "Service Maintenance Mode",
          Status: "critical",
          Notes: "test",
          Output: "",
          ServiceID: id,
          ServiceName: "dbx-demo-api",
          ServiceTags: ["demo"],
          Type: "maintenance",
          ExposedPort: 0,
          Definition: {},
          CreateIndex: 0,
          ModifyIndex: 0,
          Maintenance: true,
        };
      } else {
        delete agentChecks[checkId];
      }
      return { target: { node: "node-1", address: "127.0.0.1" } };
    }),
    catalogServiceNodes: vi.fn(async (_connectionId: string, service: string) => ({
      items: [
        {
          ID: "node-1",
          Node: "node-1",
          Address: "127.0.0.1",
          Datacenter: "dc1",
          TaggedAddresses: {},
          NodeMeta: { zone: "demo-zone" },
          ServiceKind: "",
          ServiceID: `${service}-1`,
          ServiceName: service,
          ServiceTags: ["demo"],
          ServiceAddress: "127.0.0.1",
          ServicePort: 19080,
          ServiceMeta: { owner: "DBX" },
          ServiceTaggedAddresses: {},
          ServiceWeights: { Passing: 1, Warning: 1 },
          CreateIndex: 1,
          ModifyIndex: 1,
        },
      ],
      metadata: { index: "1", knownLeader: true, lastContact: 0, queryBackend: null },
    })),
  };
});

vi.mock("@/lib/backend/api", () => ({
  consulCatalogServices: vi.fn(async () => ({
    items: { consul: [], "dbx-demo-api": ["v1", "demo", "api"] },
    metadata: { index: "1", knownLeader: true, lastContact: 0, queryBackend: null },
  })),
  consulCatalogNodes: vi.fn(async () => ({
    items: [{ ID: "node-1", Node: "node-1", Address: "127.0.0.1", Datacenter: "dc1", TaggedAddresses: {}, NodeMeta: {}, CreateIndex: 1, ModifyIndex: 1 }],
    metadata: { index: "1", knownLeader: true, lastContact: 0, queryBackend: null },
  })),
  consulCatalogServiceNodes: mocks.catalogServiceNodes,
  consulCatalogNodeServices: vi.fn(async () => ({
    items: {
      Node: { ID: "node-1", Node: "node-1", Address: "127.0.0.1", Datacenter: "dc1", TaggedAddresses: {}, NodeMeta: {}, CreateIndex: 1, ModifyIndex: 1 },
      Services: {
        "dbx-demo-node-service-1": {
          ID: "dbx-demo-node-service-1",
          Service: "dbx-demo-node-service",
          Tags: ["demo", "node"],
          Address: "127.0.0.1",
          TaggedAddresses: { lan: { Address: "127.0.0.1", Port: 19090 } },
          Meta: { owner: "DBX" },
          Port: 19090,
          Weights: { Passing: 2, Warning: 1 },
        },
      },
    },
    metadata: { index: "1", knownLeader: true, lastContact: 0, queryBackend: null },
  })),
  consulAgentSelf: vi.fn(async () => ({ node: "node-1", address: "127.0.0.1", datacenter: "dc1", version: "2.0.2", server: true, revision: null, segment: null })),
  consulAgentServices: vi.fn(async () => ({
    "dbx-demo-api-1": { Kind: "", ID: "dbx-demo-api-1", Service: "dbx-demo-api", Tags: ["demo"], Meta: {}, Port: 19080, Address: "127.0.0.1", TaggedAddresses: {}, Weights: { Passing: 1, Warning: 1 }, EnableTagOverride: false, Datacenter: "dc1" },
  })),
  consulAgentChecks: vi.fn(async () => ({ ...mocks.agentChecks })),
  consulAgentService: vi.fn(async (_connectionId: string, id: string) => ({
    Kind: "",
    ID: id,
    Service: "dbx-demo-api",
    Tags: ["demo"],
    Meta: { owner: "DBX" },
    Port: 19080,
    Address: "127.0.0.1",
    TaggedAddresses: {},
    Weights: { Passing: 1, Warning: 1 },
    EnableTagOverride: false,
    Datacenter: "dc1",
  })),
  consulAgentRegisterService: vi.fn(),
  consulAgentDeregisterService: vi.fn(),
  consulAgentServiceMaintenance: mocks.serviceMaintenance,
  consulDomainWatch: vi.fn(),
  consulCancelBlocking: vi.fn(async () => true),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => mocks.connectionConfig,
  }),
}));

vi.mock("@/stores/consulStore", () => ({
  useConsulStore: () => ({
    generation: 1,
    bindConnection: vi.fn(),
    registerOperation: vi.fn(),
    completeOperation: vi.fn(),
  }),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import ConsulServices from "../ConsulServices.vue";

const mountedApps: Array<{ unmount: () => void; host: HTMLElement }> = [];

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

afterEach(() => {
  for (const { unmount, host } of mountedApps.splice(0)) {
    unmount();
    host.remove();
  }
  vi.clearAllMocks();
  mocks.connectionConfig = { base_url: "http://127.0.0.1:8500", external_config: {} };
  for (const key of Object.keys(mocks.agentChecks)) delete mocks.agentChecks[key];
});

describe("ConsulServices interactions", () => {
  it("uses a neutral verification state before the Agent identity resolves", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(ConsulServices, { connectionId: "connection-1" });
    app.mount(host);
    mountedApps.push({ unmount: () => app.unmount(), host });

    expect(host.textContent).toContain("consul.ui.agentTargetVerifying");
    expect(host.textContent).not.toContain("consul.ui.agentReadOnly");
  });

  it("selects a Catalog service and renders its instances on click", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(ConsulServices, { connectionId: "connection-1" });
    app.mount(host);
    mountedApps.push({ unmount: () => app.unmount(), host });
    await settle();

    const serviceButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("dbx-demo-api"));
    expect(serviceButton).toBeTruthy();
    expect(serviceButton!.textContent).toBe("dbx-demo-api");
    serviceButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();

    expect(host.querySelector("h2")?.textContent).toContain("dbx-demo-api");
    expect(host.textContent).toContain("dbx-demo-api-1");
    expect(mocks.catalogServiceNodes).toHaveBeenLastCalledWith("connection-1", "dbx-demo-api");

    const catalogRow = host.querySelector('tr[role="button"]');
    expect(catalogRow).toBeTruthy();
    catalogRow!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();
    expect(host.textContent).toContain("consul.ui.nodeMeta");
    expect(host.textContent).toContain("zone=demo-zone");
    expect(host.textContent).toContain("consul.ui.serviceMeta");
    expect(catalogRow!.getAttribute("aria-expanded")).toBe("true");

    catalogRow!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();
    expect(host.textContent).not.toContain("zone=demo-zone");
    expect(catalogRow!.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps local service cards interactive while explaining read-only Agent actions", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(ConsulServices, { connectionId: "connection-1" });
    app.mount(host);
    mountedApps.push({ unmount: () => app.unmount(), host });
    await settle();

    expect(host.textContent).toContain("consul.ui.agentReadOnly");
    expect(host.textContent).toContain("consul.ui.agentWriteDisabledHint");
    expect(host.textContent).not.toContain("consul.ui.enableMaintenance");

    const localServiceButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("dbx-demo-api-1"));
    expect(localServiceButton).toBeTruthy();
    expect(localServiceButton!.hasAttribute("disabled")).toBe(false);
    localServiceButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();

    expect(host.textContent).toContain("consul.ui.enableTagOverride");
    expect(host.textContent).toContain("consul.ui.serviceWeights");
    expect(localServiceButton!.getAttribute("aria-expanded")).toBe("true");

    localServiceButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();

    expect(host.textContent).not.toContain("consul.ui.enableTagOverride");
    expect(host.textContent).not.toContain("consul.ui.serviceWeights");
    expect(localServiceButton!.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows and toggles the current service maintenance state", async () => {
    mocks.connectionConfig = {
      base_url: "http://127.0.0.1:8500",
      external_config: {
        serverAddr: "http://127.0.0.1:8500",
        agentTarget: { node: "node-1", address: "127.0.0.1" },
      },
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(ConsulServices, { connectionId: "connection-1" });
    app.mount(host);
    mountedApps.push({ unmount: () => app.unmount(), host });
    await settle();

    const enableButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("consul.ui.enableMaintenance"));
    expect(enableButton).toBeTruthy();
    enableButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();

    expect(mocks.serviceMaintenance).toHaveBeenLastCalledWith("connection-1", "dbx-demo-api-1", true, "consul.ui.maintenanceReason");
    expect(host.textContent).toContain("consul.ui.maintenance");
    const disableButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("consul.ui.disableMaintenance"));
    expect(disableButton).toBeTruthy();
    disableButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();

    expect(mocks.serviceMaintenance).toHaveBeenLastCalledWith("connection-1", "dbx-demo-api-1", false, "consul.ui.maintenanceReason");
    expect(host.textContent).not.toContain("consul.ui.maintenance");
    expect(host.textContent).toContain("consul.ui.enableMaintenance");
  });

  it("expands and collapses full service details in Catalog node view", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(ConsulServices, { connectionId: "connection-1" });
    app.mount(host);
    mountedApps.push({ unmount: () => app.unmount(), host });
    await settle();

    const nodeTab = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.trim() === "consul.ui.node");
    expect(nodeTab).toBeTruthy();
    nodeTab!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();

    const nodeServiceButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("dbx-demo-node-service-1"));
    expect(nodeServiceButton).toBeTruthy();
    nodeServiceButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();
    expect(host.textContent).toContain("owner=DBX");
    expect(host.textContent).toContain("consul.ui.serviceWeights");
    expect(host.textContent).toContain("lan=127.0.0.1:19090");
    expect(nodeServiceButton!.getAttribute("aria-expanded")).toBe("true");

    nodeServiceButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();
    expect(host.textContent).not.toContain("lan=127.0.0.1:19090");
    expect(nodeServiceButton!.getAttribute("aria-expanded")).toBe("false");
  });
});
