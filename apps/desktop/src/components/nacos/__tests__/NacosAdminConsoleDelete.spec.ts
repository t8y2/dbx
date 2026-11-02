// @vitest-environment happy-dom

import { createApp, defineComponent, h, KeepAlive, nextTick, ref, type App, type ComponentPublicInstance } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NacosConfigItem, NacosConfigKey, NacosConfigList, NacosInstanceInfo, NacosServiceInfo } from "@/types/nacos";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(),
  nacosDeleteConfig: vi.fn(),
  nacosGetConfig: vi.fn(),
  nacosGetService: vi.fn(),
  nacosListInstances: vi.fn(),
  nacosListConfigs: vi.fn(),
  nacosListServices: vi.fn(),
  nacosTestConnection: vi.fn(),
  nacosUpdateInstance: vi.fn(),
  confirmNacosMutation: vi.fn(),
  queryTabs: [] as Array<Record<string, unknown>>,
  updateNacosConfigEditorViewport: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const template =
        {
          "nacos.confirmInstanceTitle": "Update Nacos instance",
          "nacos.offline": "Offline",
          "nacos.online": "Online",
          "nacos.serviceInstancesAllHealthy": "All healthy · {healthy}/{total}",
          "nacos.serviceInstancesPartiallyHealthy": "Partially healthy · {healthy}/{total}",
          "nacos.serviceInstancesNoHealthyInstances": "No healthy instances · {healthy}/{total}",
          "nacos.serviceInstancesNoInstances": "No instances",
        }[key] ?? key;
      return Object.entries(params ?? {}).reduce((message, [name, value]) => message.replaceAll(`{${name}}`, String(value)), template);
    },
  }),
}));

vi.mock("@/lib/backend/api", () => ({
  nacosDeleteConfig: mocks.nacosDeleteConfig,
  nacosGetConfig: mocks.nacosGetConfig,
  nacosGetService: mocks.nacosGetService,
  nacosListInstances: mocks.nacosListInstances,
  nacosListConfigs: mocks.nacosListConfigs,
  nacosListServices: mocks.nacosListServices,
  nacosTestConnection: mocks.nacosTestConnection,
  nacosUpdateInstance: mocks.nacosUpdateInstance,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    connections: [],
    ensureConnected: mocks.ensureConnected,
    getConfig: () => ({ id: "connection-1", db_type: "nacos", name: "Nacos" }),
  }),
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({
    clearNacosNavigationTarget: vi.fn(),
    openNacosAdmin: vi.fn(),
    tabs: mocks.queryTabs,
    updateNacosConfigEditorViewport: mocks.updateNacosConfigEditorViewport,
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      activeCustomThemeId: "",
      customThemeColors: {},
      customThemes: [],
      fontFamily: "monospace",
      fontSize: 13,
      theme: "default",
    },
    updateEditorSettings: vi.fn(),
  }),
}));

vi.mock("@/composables/useTheme", async () => {
  const { ref } = await import("vue");
  return { useTheme: () => ({ isDark: ref(false), themePalette: ref({}) }) };
});

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

vi.mock("@/lib/database/productionExecutionGuard", () => ({
  executeWithProductionContextGuard: mocks.confirmNacosMutation,
}));

vi.mock("@/lib/database/productionSafety", () => ({
  productionContextForDatabase: () => ({ active: false, databases: [] }),
}));

vi.mock("@/lib/nacos/nacosNamespaceCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/nacos/nacosNamespaceCache")>();
  return { ...actual, subscribeNacosNamespacesChanged: () => () => undefined };
});

vi.mock("@/components/ui/button", async () => ({ Button: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Button", "button") }));
vi.mock("@/components/ui/badge", async () => ({ Badge: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Badge", "span") }));
vi.mock("@/components/ui/input", async () => ({ Input: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Input", "input") }));
vi.mock("@/components/ui/label", async () => ({ Label: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Label", "label") }));
vi.mock("@/components/ui/dialog", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const stub = createPassthroughStub("Dialog");
  return { Dialog: stub, DialogContent: stub, DialogDescription: stub, DialogFooter: stub, DialogHeader: stub, DialogTitle: stub };
});
vi.mock("@/components/ui/dropdown-menu", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const stub = createPassthroughStub("DropdownMenu");
  return { DropdownMenu: stub, DropdownMenuCheckboxItem: stub, DropdownMenuContent: stub, DropdownMenuTrigger: stub };
});
vi.mock("@/components/ui/select", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const stub = createPassthroughStub("Select");
  return { Select: stub, SelectContent: stub, SelectItem: stub, SelectTrigger: stub, SelectValue: stub };
});

vi.mock("@/components/common/ProductionContextBadge.vue", async () => ({ default: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("ProductionContextBadge") }));
vi.mock("@/components/editor/DangerConfirmDialog.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: {
        open: Boolean,
        title: String,
        message: String,
        confirmLabel: String,
      },
      emits: ["confirm", "update:open"],
      setup(props, { emit }) {
        return () =>
          props.open
            ? h(
                "button",
                {
                  "data-testid": "nacos-instance-update-confirm",
                  "data-title": props.title,
                  "data-message": props.message,
                  onClick: () => emit("confirm"),
                },
                props.confirmLabel,
              )
            : null;
      },
    }),
  };
});
vi.mock("@/components/editor/EditorSearchPanel.vue", async () => ({ default: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("EditorSearchPanel") }));
vi.mock("@/components/nacos/NacosConfigDiffDialog.vue", async () => ({ default: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("NacosConfigDiffDialog") }));
vi.mock("@/components/nacos/NacosConfigHistoryDialog.vue", async () => ({ default: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("NacosConfigHistoryDialog") }));
vi.mock("@/components/nacos/NacosConfigBatchDialog.vue", async () => ({ default: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("NacosConfigBatchDialog") }));
vi.mock("@/components/nacos/NacosContentSearchDialog.vue", async () => ({ default: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("NacosContentSearchDialog") }));

vi.mock("splitpanes", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const stub = createPassthroughStub("Splitpanes");
  return { Splitpanes: stub, Pane: stub };
});

import NacosAdminConsole from "@/components/nacos/NacosAdminConsole.vue";

type NacosAdminSetupState = {
  activeTab: "configs" | "services";
  configGroup: string;
  configPageNo: number;
  configPageSize: number;
  configEditorView: { scrollDOM: HTMLElement } | null;
  configs: NacosConfigItem[];
  instances: NacosInstanceInfo[];
  deleteConfig: () => Promise<void>;
  deleteSelectedConfigs: () => Promise<void>;
  requestBatchDeleteConfigs: () => void;
  requestDeleteConfig: () => void;
  selectedConfig: NacosConfigItem | null;
  selectedConfigKeys: string[];
  selectedConfigOriginalKey: NacosConfigKey | null;
  selectedService: NacosServiceInfo | null;
  services: NacosServiceInfo[];
  selectConfig: (item: NacosConfigItem) => Promise<void>;
  toggleConfigSelection: (item: NacosConfigItem, checked: boolean) => void;
};

const configA: NacosConfigItem = { namespace: "public", group: "DEFAULT_GROUP", dataId: "config-a", configType: "yaml" };
const configB: NacosConfigItem = { namespace: "public", group: "DEFAULT_GROUP", dataId: "config-b", configType: "text" };
let app: App | null = null;
let host: HTMLElement | null = null;
let state: NacosAdminSetupState;

function configList(pageNo: number, pageSize: number, totalCount: number, items: NacosConfigItem[]): NacosConfigList {
  return { pageNo, pageSize, totalCount, items };
}

async function flushUi() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

async function flushAnimationFrames(count: number) {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

beforeEach(async () => {
  mocks.ensureConnected.mockReset().mockResolvedValue(undefined);
  mocks.nacosDeleteConfig.mockReset().mockResolvedValue(undefined);
  mocks.nacosGetConfig.mockReset().mockResolvedValue(configA);
  mocks.nacosGetService.mockReset().mockResolvedValue({ serviceName: "api", groupName: "DEFAULT_GROUP" });
  mocks.nacosListInstances.mockReset().mockResolvedValue([]);
  mocks.nacosListConfigs.mockReset().mockResolvedValue(configList(1, 20, 2, [configA, configB]));
  mocks.nacosListServices.mockReset().mockResolvedValue({ pageNo: 1, pageSize: 20, totalCount: 0, items: [] });
  mocks.nacosTestConnection.mockReset().mockResolvedValue({
    serverAddr: "http://127.0.0.1:8848",
    displayServerAddr: "127.0.0.1:8848",
    namespace: "public",
    auth: "none",
    capabilities: { supportsConfigManagement: true, supportsConfigHistory: true, supportsServiceManagement: true, supportsInstanceUpdate: true, supportsRawApi: true },
  });
  mocks.nacosUpdateInstance.mockReset().mockResolvedValue(undefined);
  mocks.confirmNacosMutation.mockReset().mockImplementation(({ execute }: { execute: () => Promise<unknown> }) => execute());
  mocks.toast.mockReset();
  mocks.updateNacosConfigEditorViewport.mockReset();
  mocks.queryTabs.splice(0);

  host = document.createElement("div");
  document.body.append(host);
  app = createApp(NacosAdminConsole, { connectionId: "connection-1", namespace: "public" });
  const instance = app.mount(host) as ComponentPublicInstance;
  state = instance.$.setupState as unknown as NacosAdminSetupState;
  await flushUi();
  mocks.nacosListConfigs.mockClear();
  mocks.nacosDeleteConfig.mockClear();
});

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

describe("NacosAdminConsole config deletion", () => {
  it("clears a singly deleted selection and reloads the last valid filtered page", async () => {
    state.configGroup = "group-filter";
    state.configPageNo = 2;
    state.selectedConfig = configA;
    state.selectedConfigOriginalKey = { namespace: configA.namespace, group: configA.group, dataId: configA.dataId };
    state.toggleConfigSelection(configA, true);
    state.requestDeleteConfig();
    mocks.nacosListConfigs.mockResolvedValueOnce(configList(2, 20, 20, [])).mockResolvedValueOnce(configList(1, 20, 20, [configB]));

    await state.deleteConfig();
    await flushUi();

    expect(state.selectedConfigKeys).toEqual([]);
    expect(state.configPageNo).toBe(1);
    expect(state.configs).toEqual([configB]);
    expect(mocks.nacosDeleteConfig).toHaveBeenCalledWith("connection-1", { namespace: "public", group: "DEFAULT_GROUP", dataId: "config-a" });
    expect(mocks.nacosListConfigs.mock.calls.map(([, query]) => query)).toEqual([expect.objectContaining({ group: "group-filter", groupContains: true, pageNo: 2, pageSize: 20 }), expect.objectContaining({ group: "group-filter", groupContains: true, pageNo: 1, pageSize: 20 })]);
  });

  it("clears batch selections and reloads the last valid page for a different page size", async () => {
    state.configPageNo = 2;
    state.configPageSize = 50;
    state.toggleConfigSelection(configA, true);
    state.toggleConfigSelection(configB, true);
    state.requestBatchDeleteConfigs();
    mocks.nacosListConfigs.mockResolvedValueOnce(configList(2, 50, 50, [])).mockResolvedValueOnce(configList(1, 50, 50, [configB]));

    await state.deleteSelectedConfigs();
    await flushUi();

    expect(state.selectedConfigKeys).toEqual([]);
    expect(state.configPageNo).toBe(1);
    expect(mocks.nacosDeleteConfig.mock.calls.map(([, key]) => key)).toEqual([
      { namespace: "public", group: "DEFAULT_GROUP", dataId: "config-a" },
      { namespace: "public", group: "DEFAULT_GROUP", dataId: "config-b" },
    ]);
    expect(mocks.nacosListConfigs.mock.calls.map(([, query]) => query)).toEqual([expect.objectContaining({ pageNo: 2, pageSize: 50 }), expect.objectContaining({ pageNo: 1, pageSize: 50 })]);
  });
});

describe("NacosAdminConsole service instance status", () => {
  it("renders accessible text for every service health-count state", async () => {
    state.activeTab = "services";
    state.services = [
      { serviceName: "all-healthy", ipCount: 3, healthyInstanceCount: 3 },
      { serviceName: "partially-healthy", ipCount: 3, healthyInstanceCount: 2 },
      { serviceName: "no-healthy", ipCount: 3, healthyInstanceCount: 0 },
      { serviceName: "no-instances", ipCount: 0, healthyInstanceCount: 0 },
    ];
    await flushUi();

    const statuses = Array.from(host!.querySelectorAll<HTMLElement>("[data-testid=nacos-service-instance-status]"));
    expect(statuses.map((status) => status.textContent?.trim())).toEqual(["All healthy · 3/3", "Partially healthy · 2/3", "No healthy instances · 0/3", "No instances"]);
    expect(statuses.map((status) => status.className)).toEqual([expect.stringContaining("text-emerald-700"), expect.stringContaining("text-amber-700"), expect.stringContaining("text-destructive"), expect.stringContaining("text-muted-foreground")]);
  });

  it("uses Online and Offline in actions and confirmations without changing the enabled patch", async () => {
    const service: NacosServiceInfo = { serviceName: "api", groupName: "DEFAULT_GROUP", ipCount: 1, healthyInstanceCount: 1 };
    let currentInstance: NacosInstanceInfo = { ip: "127.0.0.1", port: 8080, clusterName: "DEFAULT", groupName: "DEFAULT_GROUP", enabled: true, healthy: true };
    mocks.nacosUpdateInstance.mockImplementation(async (_connectionId, request) => {
      currentInstance = { ...currentInstance, ...request.patch };
    });
    mocks.nacosListInstances.mockImplementation(async () => [currentInstance]);
    state.activeTab = "services";
    state.selectedService = service;
    state.instances = [currentInstance];
    await flushUi();

    expect(host!.querySelector("[data-testid=nacos-instance-availability-status]")?.textContent?.trim()).toBe("Online");
    let action = host!.querySelector<HTMLButtonElement>("[data-testid=nacos-instance-availability-action]");
    expect(action?.textContent?.trim()).toBe("Offline");
    action?.click();
    await flushUi();

    let confirm = host!.querySelector<HTMLButtonElement>("[data-testid=nacos-instance-update-confirm]");
    expect(confirm?.textContent?.trim()).toBe("Offline");
    expect(confirm?.getAttribute("data-title")).toBe("Update Nacos instance: Offline");
    confirm?.click();
    await vi.waitFor(() => expect(mocks.nacosUpdateInstance).toHaveBeenCalledTimes(1));
    expect(mocks.nacosUpdateInstance).toHaveBeenNthCalledWith(1, "connection-1", {
      target: {
        namespace: "public",
        serviceName: "api",
        groupName: "DEFAULT_GROUP",
        ip: "127.0.0.1",
        port: 8080,
        clusterName: "DEFAULT",
        ephemeral: undefined,
      },
      patch: { enabled: false },
    });
    expect(mocks.confirmNacosMutation).toHaveBeenNthCalledWith(1, expect.objectContaining({ reviewText: "Update Nacos instance: Offline" }));
    await flushUi();

    expect(host!.querySelector("[data-testid=nacos-instance-availability-status]")?.textContent?.trim()).toBe("Offline");
    action = host!.querySelector<HTMLButtonElement>("[data-testid=nacos-instance-availability-action]");
    expect(action?.textContent?.trim()).toBe("Online");
    action?.click();
    await flushUi();
    confirm = host!.querySelector<HTMLButtonElement>("[data-testid=nacos-instance-update-confirm]");
    expect(confirm?.textContent?.trim()).toBe("Online");
    expect(confirm?.getAttribute("data-title")).toBe("Update Nacos instance: Online");
    confirm?.click();
    await vi.waitFor(() => expect(mocks.nacosUpdateInstance).toHaveBeenCalledTimes(2));
    expect(mocks.nacosUpdateInstance.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ patch: { enabled: true } }));
    expect(mocks.confirmNacosMutation).toHaveBeenNthCalledWith(2, expect.objectContaining({ reviewText: "Update Nacos instance: Online" }));
  });
});

describe("NacosAdminConsole cached tab restoration", () => {
  it("does not let a hidden editor overwrite its viewport before reactivation", async () => {
    app?.unmount();
    host?.remove();
    const active = ref(true);
    const nacosRef = ref<ComponentPublicInstance | null>(null);
    const CachedNacos = defineComponent({
      setup() {
        return () =>
          h(KeepAlive, null, {
            default: () => [active.value ? h(NacosAdminConsole, { ref: nacosRef, connectionId: "connection-1", namespace: "public" }) : h("div", "other-tab")],
          });
      },
    });
    host = document.createElement("div");
    document.body.append(host);
    app = createApp(CachedNacos);
    app.mount(host);
    await flushUi();

    state = nacosRef.value?.$.setupState as unknown as NacosAdminSetupState;
    await state.selectConfig(configA);
    await flushUi();
    const editor = state.configEditorView;
    expect(editor).not.toBeNull();
    if (!editor) throw new Error("Expected the Nacos config editor to mount");

    editor.scrollDOM.scrollTop = 96;
    editor.scrollDOM.dispatchEvent(new Event("scroll"));
    await flushAnimationFrames(1);

    active.value = false;
    await nextTick();
    editor.scrollDOM.scrollTop = 0;
    editor.scrollDOM.dispatchEvent(new Event("scroll"));
    await flushAnimationFrames(1);

    active.value = true;
    await nextTick();
    await flushAnimationFrames(9);

    expect(mocks.updateNacosConfigEditorViewport).toHaveBeenLastCalledWith("connection-1", "public", expect.objectContaining({ scrollTop: 96 }));
    expect(editor.scrollDOM.scrollTop).toBe(96);
  });

  it("reselects the configuration saved with an evicted tab viewport", async () => {
    app?.unmount();
    host?.remove();
    mocks.queryTabs.push({
      mode: "nacos",
      connectionId: "connection-1",
      nacosNamespace: "public",
      nacosConfigEditorViewport: {
        namespace: "public",
        dataId: "config-a",
        group: "DEFAULT_GROUP",
        scrollTop: 96,
        scrollLeft: 0,
      },
    });
    host = document.createElement("div");
    document.body.append(host);
    app = createApp(NacosAdminConsole, { connectionId: "connection-1", namespace: "public" });
    const instance = app.mount(host) as ComponentPublicInstance;
    state = instance.$.setupState as unknown as NacosAdminSetupState;

    await flushUi();

    expect(mocks.nacosGetConfig).toHaveBeenCalledWith("connection-1", { namespace: "public", dataId: "config-a", group: "DEFAULT_GROUP" });
    expect(state.selectedConfig?.dataId).toBe("config-a");
  });
});
