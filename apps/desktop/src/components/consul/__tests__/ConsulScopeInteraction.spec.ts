/** @vitest-environment happy-dom */

import { createApp, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

type PendingList = {
  kind: string;
  resolve: (value: { items: Array<Record<string, unknown>> }) => void;
};

const mocks = vi.hoisted(() => ({ pendingLists: [] as PendingList[] }));

vi.mock("@/lib/backend/api", () => ({
  consulEnterpriseList: vi.fn(
    (_connectionId: string, kind: string) =>
      new Promise((resolve) => {
        mocks.pendingLists.push({ kind, resolve });
      }),
  ),
  consulEnterpriseApply: vi.fn(),
  consulEnterpriseImpact: vi.fn(),
  consulEnterpriseDelete: vi.fn(),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => ({ read_only: false, external_config: { datacenter: "dc1" } }),
  }),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import ConsulScope from "../ConsulScope.vue";

const mountedApps: Array<{ unmount: () => void; host: HTMLElement }> = [];

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

function resolveList(kind: string, items: Array<Record<string, unknown>>) {
  const index = mocks.pendingLists.findIndex((request) => request.kind === kind);
  expect(index).toBeGreaterThanOrEqual(0);
  const [request] = mocks.pendingLists.splice(index, 1);
  request.resolve({ items });
}

function activateTab(host: HTMLElement, label: string) {
  const button = Array.from(host.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === label);
  expect(button).toBeTruthy();
  button!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
}

afterEach(() => {
  for (const { unmount, host } of mountedApps.splice(0)) {
    unmount();
    host.remove();
  }
  mocks.pendingLists.splice(0);
  vi.clearAllMocks();
});

describe("ConsulScope interactions", () => {
  it("does not let a stale partition request overwrite the active namespace list", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(ConsulScope, {
      connectionId: "connection-1",
      capabilities: { namespaces: "supported", partitions: "supported" },
    });
    app.mount(host);
    mountedApps.push({ unmount: () => app.unmount(), host });
    await settle();

    resolveList("namespace", []);
    await settle();
    activateTab(host, "consul.workspace.partitions");
    await settle();
    activateTab(host, "consul.ui.namespaces");
    await settle();

    resolveList("namespace", [{ Name: "current-namespace" }]);
    await settle();
    expect(host.textContent).toContain("current-namespace");

    resolveList("partition", [{ Name: "stale-partition" }]);
    await settle();
    expect(host.textContent).toContain("current-namespace");
    expect(host.textContent).not.toContain("stale-partition");
  });
});
