// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import NacosContentReplaceDialog from "@/components/nacos/NacosContentReplaceDialog.vue";

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

async function mountDialog() {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () => h(NacosContentReplaceDialog, { open: true, connectionId: "nacos-main", currentNamespace: "public", readOnly: false }),
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
