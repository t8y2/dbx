/** @vitest-environment happy-dom */

import { createApp, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

type ListResult = { items: Array<Record<string, unknown>> };
type PendingList = {
  kind: string;
  resolve: (value: ListResult) => void;
  reject: (reason: unknown) => void;
};

const mocks = vi.hoisted(() => ({
  pendingLists: [] as PendingList[],
  referencesError: "",
}));

vi.mock("@/lib/backend/api", () => ({
  consulAclList: vi.fn(
    (_connectionId: string, kind: string) =>
      new Promise<ListResult>((resolve, reject) => {
        mocks.pendingLists.push({ kind, resolve, reject });
      }),
  ),
  consulAclReferences: vi.fn(async () => {
    if (mocks.referencesError) throw new Error(mocks.referencesError);
    return { tokenAccessorIds: [], roleIds: [], bindingRuleIds: [], complete: true };
  }),
  consulAclGet: vi.fn(),
  consulAclApply: vi.fn(),
  consulAclTokenClone: vi.fn(),
  consulAclDelete: vi.fn(),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ getConfig: () => ({ read_only: false }) }),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import ConsulAcl from "../ConsulAcl.vue";

const capabilities = {
  acl: "supported",
  authMethods: "supported",
  bindingRules: "supported",
  templatedPolicies: "supported",
};
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

function clickButton(host: HTMLElement, label: string) {
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
  mocks.referencesError = "";
  vi.clearAllMocks();
});

describe("ConsulAcl interactions", () => {
  it("ignores a stale ACL list response after switching resource kinds", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(ConsulAcl, { connectionId: "connection-1", capabilities });
    app.mount(host);
    mountedApps.push({ unmount: () => app.unmount(), host });
    await settle();

    resolveList("token", []);
    await settle();
    clickButton(host, "consul.ui.policies");
    await settle();
    clickButton(host, "consul.ui.roles");
    await settle();

    resolveList("role", [{ ID: "role-1", Name: "current-role" }]);
    await settle();
    expect(host.textContent).toContain("current-role");

    resolveList("policy", [{ ID: "policy-1", Name: "stale-policy" }]);
    await settle();
    expect(host.textContent).toContain("current-role");
    expect(host.textContent).not.toContain("stale-policy");
  });

  it("shows an ACL operation error instead of failing silently", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(ConsulAcl, { connectionId: "connection-1", capabilities });
    app.mount(host);
    mountedApps.push({ unmount: () => app.unmount(), host });
    await settle();

    resolveList("token", [{ AccessorID: "token-1", Description: "test-token" }]);
    await settle();
    mocks.referencesError = "reference lookup failed";
    const deleteButton = host.querySelector('button[title="consul.ui.deleteAndInspectReferences"]');
    expect(deleteButton).toBeTruthy();
    deleteButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();

    expect(host.textContent).toContain("reference lookup failed");
  });
});
