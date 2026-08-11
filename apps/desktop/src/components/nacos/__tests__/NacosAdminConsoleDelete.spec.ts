// @vitest-environment happy-dom

import { createApp, nextTick, type App, type ComponentPublicInstance } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NacosConfigItem, NacosConfigKey, NacosConfigList } from "@/types/nacos";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(),
  nacosDeleteConfig: vi.fn(),
  nacosListConfigs: vi.fn(),
  nacosListServices: vi.fn(),
  nacosTestConnection: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

vi.mock("@/lib/backend/api", () => ({
  nacosDeleteConfig: mocks.nacosDeleteConfig,
  nacosListConfigs: mocks.nacosListConfigs,
  nacosListServices: mocks.nacosListServices,
  nacosTestConnection: mocks.nacosTestConnection,
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
  executeWithProductionContextGuard: ({ execute }: { execute: () => Promise<unknown> }) => execute(),
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
vi.mock("@/components/editor/DangerConfirmDialog.vue", async () => ({ default: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("DangerConfirmDialog") }));
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
  configGroup: string;
  configPageNo: number;
  configPageSize: number;
  configs: NacosConfigItem[];
  deleteConfig: () => Promise<void>;
  deleteSelectedConfigs: () => Promise<void>;
  requestBatchDeleteConfigs: () => void;
  requestDeleteConfig: () => void;
  selectedConfig: NacosConfigItem | null;
  selectedConfigKeys: string[];
  selectedConfigOriginalKey: NacosConfigKey | null;
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

beforeEach(async () => {
  mocks.ensureConnected.mockReset().mockResolvedValue(undefined);
  mocks.nacosDeleteConfig.mockReset().mockResolvedValue(undefined);
  mocks.nacosListConfigs.mockReset().mockResolvedValue(configList(1, 20, 2, [configA, configB]));
  mocks.nacosListServices.mockReset().mockResolvedValue({ pageNo: 1, pageSize: 20, totalCount: 0, items: [] });
  mocks.nacosTestConnection.mockReset().mockResolvedValue({
    serverAddr: "http://127.0.0.1:8848",
    displayServerAddr: "127.0.0.1:8848",
    namespace: "public",
    auth: "none",
    capabilities: { supportsConfigManagement: true, supportsConfigHistory: true, supportsServiceManagement: true, supportsInstanceUpdate: true, supportsRawApi: true },
  });
  mocks.toast.mockReset();

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
