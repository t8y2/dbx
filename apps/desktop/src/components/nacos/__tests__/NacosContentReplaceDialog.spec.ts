// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import NacosContentReplaceDialog from "@/components/nacos/NacosContentReplaceDialog.vue";
import * as historyStorage from "@/lib/nacos/nacosReplaceHistoryStorage";
import { buildNacosContentReplacePlan } from "@/lib/nacos/nacosContentReplace";
import { nacosHistoryTarget, type NacosReplaceHistoryEntry } from "@/lib/nacos/nacosReplaceHistory";

const api = vi.hoisted(() => ({
  nacosSearchConfigContent: vi.fn(),
  nacosCancelConfigContentSearch: vi.fn(),
  nacosGetConfig: vi.fn(),
  nacosPublishConfig: vi.fn(),
  loadConnections: vi.fn(),
}));

const history = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/nacos/nacosReplaceHistoryStorage", () => ({
  saveNacosReplaceHistory: vi.fn(async (entry) => {
    history.set(entry.id, JSON.parse(JSON.stringify(entry)));
  }),
  listNacosReplaceHistory: vi.fn(async () => [...history.values()]),
  getNacosReplaceHistory: vi.fn(async (id) => structuredClone(history.get(id))),
  deleteNacosReplaceHistory: vi.fn(async (id) => {
    history.delete(id);
  }),
}));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({
  default: defineComponent({ props: { open: Boolean }, emits: ["confirm"], template: '<button v-if="open" data-testid="history-confirm" @click="$emit(\'confirm\')">Confirm</button>' }),
}));

vi.mock("@/lib/backend/api", () => api);

vi.mock("@/components/nacos/NacosConfigDiffDialog.vue", () => ({
  default: defineComponent({
    props: { open: Boolean, before: String, after: String },
    template: '<div v-if="open" data-testid="nacos-replace-diff" :data-before="before" :data-after="after" />',
  }),
}));

const mountedApps: App[] = [];
beforeEach(() => {
  history.clear();
  api.loadConnections.mockResolvedValue([{ id: "nacos-main", host: "localhost", port: 8848, external_config: { serverAddr: "http://localhost:8848" } }]);
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name: string, _options: unknown, cb: (lock: object) => unknown) => cb({}) } });
});

async function mountDialog(readOnly = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () => h(NacosContentReplaceDialog, { open: true, connectionId: "nacos-main", currentNamespace: "public", readOnly }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  await nextTick();
}

function input(testId: string, value: string) {
  const element = document.body.querySelector(`[data-testid=${testId}]`) as HTMLInputElement;
  element.value = value;
  element.dispatchEvent(new Event("input"));
}

async function click(testId: string) {
  await nextTick();
  const element = document.body.querySelector(`[data-testid=${testId}]`) as HTMLButtonElement;
  if (element.getAttribute("role") === "tab") element.dispatchEvent(new MouseEvent("mousedown", { button: 0, ctrlKey: false, bubbles: true }));
  else element.click();
  await nextTick();
  await nextTick();
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("NacosContentReplaceDialog", () => {
  function historicalEntry(): NacosReplaceHistoryEntry {
    const plan = buildNacosContentReplacePlan([{ namespace: "public", group: "test", dataId: "historical.yaml", content: "mysql-old" }], "mysql-old", "mysql-new");
    return {
      version: 1,
      id: "batch",
      connectionId: "nacos-main",
      target: nacosHistoryTarget({ id: "nacos-main", host: "localhost", port: 8848, external_config: { serverAddr: "http://localhost:8848" } }),
      createdAt: 1,
      updatedAt: 1,
      scope: { scope: "currentNamespace", namespace: "public", group: "test", dataId: "historical" },
      state: "completed",
      plan,
      report: { ...plan, items: [{ ...plan.items[0], status: "replaced", appliedMd5: "after" }], replaced: 1, conflicts: 0, failed: 0, cancelled: false },
    };
  }

  it("requires confirmation to delete only a local record without publishing configs", async () => {
    history.set("batch", historicalEntry());
    await mountDialog();
    await click("nacos-replace-history-tab");
    await vi.waitFor(() => expect(document.body.textContent).toContain("1 replaced"));
    (document.body.querySelector('[aria-label="Delete record"]') as HTMLButtonElement).click();
    await nextTick();
    expect(history.has("batch")).toBe(true);
    await click("history-confirm");
    await vi.waitFor(() => expect(history.has("batch")).toBe(false));
    expect(api.nacosPublishConfig).not.toHaveBeenCalled();
  });

  it("allows read-only history and diff inspection but blocks historical rollback", async () => {
    history.set("batch", historicalEntry());
    await mountDialog(true);
    await click("nacos-replace-history-tab");
    await vi.waitFor(() => expect(document.body.querySelector("[data-testid=nacos-replace-history-details]")).not.toBeNull());
    await click("nacos-replace-history-details");
    expect((document.body.querySelector("[data-testid=nacos-replace-history-rollback]") as HTMLButtonElement).disabled).toBe(true);
    (document.body.querySelector('[aria-label="View replacement diff"]') as HTMLButtonElement).click();
    await nextTick();
    expect(document.body.querySelector("[data-testid=nacos-replace-diff]")?.getAttribute("data-before")).toBe("mysql-old");
    expect(api.nacosPublishConfig).not.toHaveBeenCalled();
  });

  it("renders unfinished batches, uncertain items, pending items and individual error messages", async () => {
    const entry = historicalEntry();
    entry.state = "applying";
    entry.inFlight = { key: entry.plan.items[0].key, phase: "apply" };
    entry.plan.items.push({ ...entry.plan.items[0], key: "pending", dataId: "pending.yaml" });
    entry.report.items[0].message = "individual verification error";
    history.set("batch", entry);
    await mountDialog();
    await click("nacos-replace-history-tab");
    await vi.waitFor(() => expect(document.body.querySelector("[data-testid=nacos-replace-history-details]")).not.toBeNull());
    await click("nacos-replace-history-details");
    expect(document.body.textContent).toContain("Uncertain");
    expect(document.body.textContent).toContain("Not executed");
    expect(document.body.textContent).toContain("individual verification error");
    expect((document.body.querySelector("[data-testid=nacos-replace-history-rollback]") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows secure-storage read failures instead of silently pretending history is empty", async () => {
    vi.mocked(historyStorage.listNacosReplaceHistory).mockRejectedValueOnce(new Error("nacos-history-storage-failed"));
    await mountDialog();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Could not save or read batch history"));
    expect(api.nacosPublishConfig).not.toHaveBeenCalled();
  });

  it("blocks a historical rollback after the saved connection target changes", async () => {
    history.set("batch", historicalEntry());
    await mountDialog();
    await click("nacos-replace-history-tab");
    await vi.waitFor(() => expect(document.body.querySelector("[data-testid=nacos-replace-history-details]")).not.toBeNull());
    await click("nacos-replace-history-details");
    api.loadConnections.mockResolvedValue([{ id: "nacos-main", host: "other", port: 8848 }]);
    await click("nacos-replace-history-rollback");
    await click("history-confirm");
    await vi.waitFor(() => expect(document.body.textContent).toContain("different Nacos server"));
    expect(api.nacosPublishConfig).not.toHaveBeenCalled();
  });

  it("does not publish or keep an applicable stale preview after a backup-save error", async () => {
    api.nacosSearchConfigContent.mockResolvedValue({ matches: [{ namespace: "public", group: "test", dataId: "historical.yaml" }], failures: [] });
    api.nacosGetConfig.mockResolvedValue({ namespace: "public", group: "test", dataId: "historical.yaml", content: "mysql-old" });
    await mountDialog();
    input("nacos-replace-search", "mysql-old");
    input("nacos-replace-value", "mysql-new");
    await click("nacos-replace-preview");
    await vi.waitFor(() => expect(document.body.querySelector("[data-testid=nacos-replace-apply]")).not.toBeNull());
    vi.mocked(historyStorage.saveNacosReplaceHistory).mockRejectedValueOnce(new Error("nacos-history-storage-failed"));
    await click("nacos-replace-apply");
    await vi.waitFor(() => expect(document.body.textContent).toContain("Could not save or read batch history"));
    expect(document.body.querySelector("[data-testid=nacos-replace-apply]")).toBeNull();
    expect(api.nacosPublishConfig).not.toHaveBeenCalled();
  });
  it("previews and applies one literal replacement across every matching Data ID and namespace", async () => {
    const configs = new Map([
      ["public/DEFAULT_GROUP/application.yaml", { namespace: "public", group: "DEFAULT_GROUP", dataId: "application.yaml", content: "url: mysql-old:3306\nreplica: mysql-old:3306", configType: "yaml", md5: "app-before" }],
      ["tenant-a/orders/orders.yaml", { namespace: "tenant-a", group: "orders", dataId: "orders.yaml", content: "dsn=mysql-old:3306/orders", configType: "yaml", md5: "orders-before" }],
    ]);
    api.nacosSearchConfigContent.mockResolvedValue({
      operationId: "replace-search",
      scanned: 2,
      matches: [
        { namespace: "public", group: "DEFAULT_GROUP", dataId: "application.yaml", lineNumber: 1, snippet: "mysql-old:3306" },
        { namespace: "tenant-a", group: "orders", dataId: "orders.yaml", lineNumber: 1, snippet: "mysql-old:3306" },
      ],
      failures: [],
      truncated: false,
      cancelled: false,
      incomplete: false,
    });
    api.nacosGetConfig.mockImplementation(async (_connectionId: string, key: { namespace: string; group: string; dataId: string }) => configs.get(`${key.namespace}/${key.group}/${key.dataId}`));
    api.nacosPublishConfig.mockImplementation(async (_connectionId: string, request: { namespace: string; group: string; dataId: string; content: string }) => {
      const key = `${request.namespace}/${request.group}/${request.dataId}`;
      configs.set(key, { ...configs.get(key)!, ...request, md5: `${request.dataId}-after` });
    });

    await mountDialog();
    input("nacos-replace-search", "mysql-old:3306");
    input("nacos-replace-value", "mysql-new:3306");
    const scope = document.body.querySelector("[data-testid=nacos-replace-scope]") as HTMLSelectElement;
    scope.value = "allNamespaces";
    scope.dispatchEvent(new Event("change"));
    await click("nacos-replace-preview");

    expect(api.nacosSearchConfigContent).toHaveBeenCalledWith("nacos-main", expect.objectContaining({ scope: "allNamespaces", query: "mysql-old:3306", maxResults: 10_000 }), expect.any(Function));
    await vi.waitFor(() => expect(document.body.textContent).toContain("2 configs"));
    expect(document.body.textContent).toContain("2 configs");
    expect(document.body.textContent).toContain("3 replacements");
    expect(document.body.textContent).toContain("application.yaml");
    expect(document.body.textContent).toContain("orders.yaml");

    await click("nacos-replace-apply");

    await vi.waitFor(() => expect(api.nacosPublishConfig).toHaveBeenCalledTimes(2));
    expect(api.nacosPublishConfig).toHaveBeenCalledTimes(2);
    expect(api.nacosPublishConfig).toHaveBeenCalledWith("nacos-main", expect.objectContaining({ dataId: "application.yaml", content: "url: mysql-new:3306\nreplica: mysql-new:3306", casMd5: "app-before" }));
    expect(api.nacosPublishConfig).toHaveBeenCalledWith("nacos-main", expect.objectContaining({ dataId: "orders.yaml", content: "dsn=mysql-new:3306/orders", casMd5: "orders-before" }));
    expect(document.body.textContent).toContain("2 replaced");

    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.innerHTML = "";
    await mountDialog();
    await click("nacos-replace-history-tab");
    await vi.waitFor(() => expect(document.body.textContent).toContain("2 replaced"));
    await click("nacos-replace-history-details");
    expect(document.body.textContent).toContain("application.yaml");
    await click("nacos-replace-history-rollback");
    expect(api.nacosPublishConfig).toHaveBeenCalledTimes(2);
    await click("history-confirm");
    await vi.waitFor(() => expect(api.nacosPublishConfig).toHaveBeenCalledTimes(4));
    expect(configs.get("public/DEFAULT_GROUP/application.yaml")?.content).toContain("mysql-old:3306");
  });

  it("selects every preview result by default and switches the inline diff from the result list", async () => {
    const configs = new Map([
      ["public/DEFAULT_GROUP/application.yaml", { namespace: "public", group: "DEFAULT_GROUP", dataId: "application.yaml", content: "primary=mysql-old", md5: "app-before" }],
      ["public/DEFAULT_GROUP/orders.yaml", { namespace: "public", group: "DEFAULT_GROUP", dataId: "orders.yaml", content: "replica=mysql-old", md5: "orders-before" }],
    ]);
    api.nacosSearchConfigContent.mockResolvedValue({
      matches: [
        { namespace: "public", group: "DEFAULT_GROUP", dataId: "application.yaml" },
        { namespace: "public", group: "DEFAULT_GROUP", dataId: "orders.yaml" },
      ],
      failures: [],
      truncated: false,
      cancelled: false,
      incomplete: false,
    });
    api.nacosGetConfig.mockImplementation(async (_connectionId: string, key: { namespace: string; group: string; dataId: string }) => configs.get(`${key.namespace}/${key.group}/${key.dataId}`));

    await mountDialog();
    input("nacos-replace-search", "mysql-old");
    input("nacos-replace-value", "mysql-new");
    await click("nacos-replace-preview");

    await vi.waitFor(() => expect(document.body.querySelector("[data-testid=nacos-replace-select-all]")).not.toBeNull());
    expect((document.body.querySelector("[data-testid=nacos-replace-select-all]") as HTMLInputElement).checked).toBe(true);
    expect((document.body.querySelector("[data-testid=nacos-replace-select-0]") as HTMLInputElement).checked).toBe(true);
    expect((document.body.querySelector("[data-testid=nacos-replace-select-1]") as HTMLInputElement).checked).toBe(true);
    expect(document.body.querySelector("[data-testid=nacos-replace-inline-diff]")?.textContent).toContain("primary=mysql-new");

    await click("nacos-replace-item-1");
    expect(document.body.querySelector("[data-testid=nacos-replace-inline-diff]")?.textContent).toContain("replica=mysql-new");
    expect(document.body.querySelector("[data-testid=nacos-replace-inline-diff]")?.textContent).not.toContain("primary=mysql-new");
  });

  it("publishes and stores history for only the selected preview results", async () => {
    const configs = new Map([
      ["public/DEFAULT_GROUP/application.yaml", { namespace: "public", group: "DEFAULT_GROUP", dataId: "application.yaml", content: "primary=mysql-old", md5: "app-before" }],
      ["public/DEFAULT_GROUP/orders.yaml", { namespace: "public", group: "DEFAULT_GROUP", dataId: "orders.yaml", content: "replica=mysql-old", md5: "orders-before" }],
    ]);
    api.nacosSearchConfigContent.mockResolvedValue({
      matches: [
        { namespace: "public", group: "DEFAULT_GROUP", dataId: "application.yaml" },
        { namespace: "public", group: "DEFAULT_GROUP", dataId: "orders.yaml" },
      ],
      failures: [],
      truncated: false,
      cancelled: false,
      incomplete: false,
    });
    api.nacosGetConfig.mockImplementation(async (_connectionId: string, key: { namespace: string; group: string; dataId: string }) => configs.get(`${key.namespace}/${key.group}/${key.dataId}`));
    api.nacosPublishConfig.mockImplementation(async (_connectionId: string, request: { namespace: string; group: string; dataId: string; content: string }) => {
      const key = `${request.namespace}/${request.group}/${request.dataId}`;
      configs.set(key, { ...configs.get(key)!, ...request, md5: `${request.dataId}-after` });
    });

    await mountDialog();
    input("nacos-replace-search", "mysql-old");
    input("nacos-replace-value", "mysql-new");
    await click("nacos-replace-preview");
    await vi.waitFor(() => expect(document.body.querySelector("[data-testid=nacos-replace-select-1]")).not.toBeNull());
    await click("nacos-replace-select-1");

    expect(document.body.querySelector("[data-testid=nacos-replace-apply]")?.textContent).toContain("1");
    expect((document.body.querySelector("[data-testid=nacos-replace-select-all]") as HTMLInputElement).indeterminate).toBe(true);
    await click("nacos-replace-apply");

    await vi.waitFor(() => expect(api.nacosPublishConfig).toHaveBeenCalledTimes(1));
    expect(api.nacosPublishConfig).toHaveBeenCalledWith("nacos-main", expect.objectContaining({ dataId: "application.yaml", content: "primary=mysql-new" }));
    expect(configs.get("public/DEFAULT_GROUP/orders.yaml")?.content).toBe("replica=mysql-old");
    const saved = [...history.values()][0] as NacosReplaceHistoryEntry;
    expect(saved.plan.items.map((item) => item.dataId)).toEqual(["application.yaml"]);
    expect(saved.plan.totalReplacements).toBe(1);
    expect(saved.report.items.map((item) => item.dataId)).toEqual(["application.yaml"]);

    await click("nacos-replace-history-rollback");
    await click("history-confirm");
    await vi.waitFor(() => expect(api.nacosPublishConfig).toHaveBeenCalledTimes(2));
    expect(configs.get("public/DEFAULT_GROUP/application.yaml")?.content).toBe("primary=mysql-old");
    expect(configs.get("public/DEFAULT_GROUP/orders.yaml")?.content).toBe("replica=mysql-old");
  });

  it("disables replacement when every preview result is deselected", async () => {
    api.nacosSearchConfigContent.mockResolvedValue({
      matches: [{ namespace: "public", group: "DEFAULT_GROUP", dataId: "application.yaml" }],
      failures: [],
      truncated: false,
      cancelled: false,
      incomplete: false,
    });
    api.nacosGetConfig.mockResolvedValue({ namespace: "public", group: "DEFAULT_GROUP", dataId: "application.yaml", content: "mysql-old", md5: "before" });

    await mountDialog();
    input("nacos-replace-search", "mysql-old");
    input("nacos-replace-value", "mysql-new");
    await click("nacos-replace-preview");
    await vi.waitFor(() => expect(document.body.querySelector("[data-testid=nacos-replace-select-all]")).not.toBeNull());
    await click("nacos-replace-select-all");

    expect((document.body.querySelector("[data-testid=nacos-replace-apply]") as HTMLButtonElement).disabled).toBe(true);
    expect((document.body.querySelector("[data-testid=nacos-replace-select-0]") as HTMLInputElement).checked).toBe(false);
    await click("nacos-replace-apply");
    expect(api.nacosPublishConfig).not.toHaveBeenCalled();

    await click("nacos-replace-select-all");
    expect((document.body.querySelector("[data-testid=nacos-replace-select-0]") as HTMLInputElement).checked).toBe(true);
    expect((document.body.querySelector("[data-testid=nacos-replace-apply]") as HTMLButtonElement).disabled).toBe(false);

    await click("nacos-replace-select-all");
    await click("nacos-replace-preview");
    await vi.waitFor(() => expect((document.body.querySelector("[data-testid=nacos-replace-select-0]") as HTMLInputElement).checked).toBe(true));
  });

  it("blocks apply when the global search result is incomplete", async () => {
    api.nacosSearchConfigContent.mockResolvedValue({ operationId: "replace-search", scanned: 10_000, matches: [], failures: [], truncated: true, cancelled: false, incomplete: true });

    await mountDialog();
    input("nacos-replace-search", "mysql-old");
    input("nacos-replace-value", "mysql-new");
    await click("nacos-replace-preview");

    await vi.waitFor(() => expect(document.body.textContent).toContain("incomplete"));
    expect(document.body.textContent).toContain("incomplete");
    expect(document.body.querySelector("[data-testid=nacos-replace-apply]")).toBeNull();
  });

  it("invalidates the preview when a replacement condition changes", async () => {
    api.nacosSearchConfigContent.mockResolvedValue({
      operationId: "replace-search",
      scanned: 1,
      matches: [{ namespace: "public", group: "DEFAULT_GROUP", dataId: "application.yaml", lineNumber: 1, snippet: "mysql-old" }],
      failures: [],
      truncated: false,
      cancelled: false,
      incomplete: false,
    });
    api.nacosGetConfig.mockResolvedValue({ namespace: "public", group: "DEFAULT_GROUP", dataId: "application.yaml", content: "host=mysql-old", md5: "before" });

    await mountDialog();
    input("nacos-replace-search", "mysql-old");
    input("nacos-replace-value", "mysql-new");
    await click("nacos-replace-preview");
    await vi.waitFor(() => expect(document.body.querySelector("[data-testid=nacos-replace-apply]")).not.toBeNull());

    input("nacos-replace-value", "mysql-newer");
    await nextTick();

    expect(document.body.querySelector("[data-testid=nacos-replace-apply]")).toBeNull();
  });
});
