// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDriverInfo } from "@/lib/backend/tauri";
import type { JdbcPluginStatus } from "@/types/database";
import { COMPONENT_DRIVER_UPDATES_CHANGED_EVENT } from "@/lib/updates/componentUpdateEvents";

const mocks = vi.hoisted(() => ({
  listInstalledAgentsLocal: vi.fn(),
  listInstalledAgents: vi.fn(),
  invalidateAgentRegistryCache: vi.fn(),
  getAgentJavaRuntimeConfig: vi.fn(),
  getDriverStoreUsage: vi.fn(),
  getDriverStorePath: vi.fn(),
  listenAgentInstallProgress: vi.fn(),
  listJdbcDrivers: vi.fn(),
  listJdbcMavenBundles: vi.fn(),
  listJdbcLocalBundles: vi.fn(),
  jdbcPluginStatus: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => mocks);
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/stores/settingsStore", async () => {
  const { reactive } = await import("vue");
  return {
    useSettingsStore: () =>
      reactive({
        desktopSettings: { driver_store_dir: null, plugin_store_dir: null, agent_store_dir: null },
        editorSettings: { updateDownloadSource: "official" },
        updateEditorSettings: vi.fn(),
      }),
  };
});
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

function passthrough(name: string, tag = "div") {
  return defineComponent({
    name,
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => h(tag, attrs, [slots.default?.(), slots.content?.(), slots.header?.(), slots.footer?.()]);
    },
  });
}

vi.mock("@/components/ui/button", () => ({ Button: passthrough("Button", "button") }));
vi.mock("@/components/ui/input", () => ({ Input: passthrough("Input", "input") }));
vi.mock("@/components/ui/label", () => ({ Label: passthrough("Label", "label") }));
vi.mock("@/components/ui/badge", () => ({ Badge: passthrough("Badge", "span") }));
vi.mock("@/components/ui/select", () => ({ Select: passthrough("Select"), SelectContent: passthrough("SelectContent"), SelectItem: passthrough("SelectItem"), SelectTrigger: passthrough("SelectTrigger"), SelectValue: passthrough("SelectValue") }));
vi.mock("@/components/ui/tooltip", () => ({ Tooltip: passthrough("Tooltip"), TooltipContent: passthrough("TooltipContent"), TooltipTrigger: passthrough("TooltipTrigger") }));
vi.mock("@/components/ui/tabs", () => ({ Tabs: passthrough("Tabs"), TabsContent: passthrough("TabsContent"), TabsList: passthrough("TabsList"), TabsTrigger: passthrough("TabsTrigger") }));
vi.mock("@/components/config/DriverInstallProgressCircle.vue", () => ({ default: passthrough("DriverInstallProgressCircle") }));
vi.mock("@/components/config/DriverStoreAgentRow.vue", () => ({ default: passthrough("DriverStoreAgentRow") }));
vi.mock("@/components/config/AgentOfflineExportDialog.vue", () => ({ default: passthrough("AgentOfflineExportDialog") }));

import DriverStoreDialog from "@/components/config/DriverStoreDialog.vue";

function driver(updateAvailable: boolean): AgentDriverInfo {
  return {
    db_type: "oracle",
    label: "Oracle",
    version: "2.0.0",
    size: 1,
    installed: true,
    installed_version: updateAvailable ? "1.0.0" : "2.0.0",
    update_available: updateAvailable,
    jre: "21",
    jre_installed: true,
  };
}

function jdbcStatus(updateAvailable: boolean): JdbcPluginStatus {
  return {
    installed: true,
    version: updateAvailable ? "1.0.0" : "2.0.0",
    compatible: true,
    latest_version: "2.0.0",
    update_available: updateAvailable,
    path: "/tmp/jdbc",
  };
}

async function flushUi() {
  for (let index = 0; index < 10; index++) {
    await Promise.resolve();
    await nextTick();
  }
}

let app: App;
let host: HTMLElement;
let updateCountChange: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.listInstalledAgentsLocal.mockResolvedValue([driver(true)]);
  mocks.listInstalledAgents.mockResolvedValue([driver(true)]);
  mocks.invalidateAgentRegistryCache.mockResolvedValue(undefined);
  mocks.getAgentJavaRuntimeConfig.mockResolvedValue({ mode: "managed", custom_java_path: null });
  mocks.getDriverStoreUsage.mockResolvedValue(null);
  mocks.getDriverStorePath.mockResolvedValue({ driver_store_dir: "", plugin_store_dir: "", agent_store_dir: "", plugins_dir: "", agents_dir: "" });
  mocks.listenAgentInstallProgress.mockResolvedValue(vi.fn());
  mocks.listJdbcDrivers.mockResolvedValue([]);
  mocks.listJdbcMavenBundles.mockResolvedValue([]);
  mocks.listJdbcLocalBundles.mockResolvedValue([]);
  mocks.jdbcPluginStatus.mockResolvedValue(jdbcStatus(true));

  host = document.createElement("div");
  document.body.append(host);
  updateCountChange = vi.fn();
  app = createApp({
    render: () =>
      h(DriverStoreDialog, {
        activeTab: "agent",
        onUpdateCountChange: updateCountChange,
      }),
  });
  app.mount(host);
  await flushUi();
});

afterEach(() => {
  app.unmount();
  host.remove();
});

describe("DriverStoreDialog external component update sync", () => {
  it("refreshes local agent and JDBC state when the update center changes drivers", async () => {
    updateCountChange.mockClear();
    mocks.listInstalledAgents.mockResolvedValueOnce([driver(false)]);
    mocks.jdbcPluginStatus.mockResolvedValueOnce(jdbcStatus(false));

    window.dispatchEvent(new Event(COMPONENT_DRIVER_UPDATES_CHANGED_EVENT));
    await flushUi();

    expect(mocks.invalidateAgentRegistryCache).toHaveBeenCalledTimes(2);
    expect(mocks.listInstalledAgents).toHaveBeenCalledTimes(2);
    expect(mocks.listJdbcDrivers).toHaveBeenCalledTimes(2);
    expect(mocks.jdbcPluginStatus).toHaveBeenCalledTimes(2);
    expect(updateCountChange).toHaveBeenLastCalledWith(0);
  });
});
