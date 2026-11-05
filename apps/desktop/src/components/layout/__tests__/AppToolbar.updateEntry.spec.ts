// @vitest-environment happy-dom
import { createApp, nextTick, type Component } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getAllWebviewWindows: vi.fn(async () => []),
  WebviewWindow: { getByLabel: vi.fn(async () => null) },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    isMaximized: async () => false,
    isFullscreen: async () => false,
    isAlwaysOnTop: async () => false,
    setAlwaysOnTop: async () => {},
    onResized: async () => () => {},
    onFocusChanged: async () => () => {},
    minimize: async () => {},
    toggleMaximize: async () => {},
  }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: { name: "ButtonStub", template: `<button><slot /></button>` },
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: { name: "TooltipStub", template: `<span><slot /></span>` },
  TooltipTrigger: { name: "TooltipTriggerStub", template: `<span><slot /></span>` },
  TooltipContent: { name: "TooltipContentStub", template: `<span><slot /></span>` },
}));
vi.mock("@/components/ui/LightDropdown.vue", () => ({
  default: { name: "LightDropdownStub", template: `<div />` },
}));
vi.mock("@/components/layout/WindowControls.vue", () => ({
  default: { name: "WindowControlsStub", template: `<div />` },
}));
vi.mock("@/components/export/ExportProgressPopover.vue", () => ({
  default: { name: "ExportProgressPopoverStub", template: `<div />` },
}));
vi.mock("@/components/layout/ToolbarUpdateIcon.vue", () => ({
  default: { name: "ToolbarUpdateIconStub", template: `<span data-toolbar-update-idle />` },
}));

import AppToolbar from "../AppToolbar.vue";
import { useSettingsStore } from "@/stores/settingsStore";

const defaultToolbarProps = {
  isDark: false,
  themeMode: "system" as const,
  showSidebarExpand: false,
  showAiPanel: false,
  activeAiRunCount: 0,
  awaitingAiRunCount: 0,
  showHistory: false,
  showSqlLibrary: false,
  sqlLibrarySaveFeedbackId: 0,
  showSqlFilePanel: false,
  showDriverStore: false,
  showPluginCenter: false,
  showSettingsPage: false,
  checkingUpdates: false,
  hasUpdateAvailable: false,
  isDownloadingUpdate: false,
  downloadProgress: null,
  updateReadyToInstall: false,
  updateReady: false,
  agentDriverUpdateCount: 0,
  hasMcpUpdateAvailable: false,
  hasConnections: false,
  canNewQuery: false,
  hasSqlFileConnections: false,
  immediateSyncing: false,
};

let pinia: ReturnType<typeof createPinia>;
let mounted: { host: HTMLDivElement; unmount: () => void } | null = null;

function mount(props: Record<string, unknown> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(AppToolbar, {
    ...defaultToolbarProps,
    ...props,
  });
  app.use(pinia);
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      missingWarn: false,
      fallbackWarn: false,
      messages: {
        en: {
          settings: { title: "Settings" },
          toolbar: { theme: "Theme" },
          updates: { check: "Check for updates", updateAction: "Update" },
          exportProgress: { tooltip: "Export" },
        },
      },
    }),
  );
  app.mount(host);
  return {
    host,
    unmount: () => {
      app.unmount();
      host.remove();
    },
  };
}

describe("AppToolbar update entry visibility", () => {
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
  });

  it("hides the toolbar update control when checkUpdates is off even if an update is available", async () => {
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.toolbarItems.checkUpdates = false;

    mounted = mount({ hasUpdateAvailable: true });
    await nextTick();

    expect(mounted.host.querySelector("[data-toolbar-update-trigger]")).toBeNull();
  });

  it("shows the labeled update action when checkUpdates is on and an update is available", async () => {
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.toolbarItems.checkUpdates = true;

    mounted = mount({ hasUpdateAvailable: true });
    await nextTick();

    const trigger = mounted.host.querySelector("[data-toolbar-update-trigger]");
    expect(trigger).not.toBeNull();
    expect(trigger?.hasAttribute("data-toolbar-update-action")).toBe(true);
    expect(trigger?.textContent).toContain("Update");
  });

  it("shows the idle check control when checkUpdates is on and no update is available", async () => {
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.toolbarItems.checkUpdates = true;

    mounted = mount({ hasUpdateAvailable: false });
    await nextTick();

    const trigger = mounted.host.querySelector("[data-toolbar-update-trigger]");
    expect(trigger).not.toBeNull();
    expect(trigger?.hasAttribute("data-toolbar-update-action")).toBe(false);
    expect(mounted.host.querySelector("[data-toolbar-update-idle]")).not.toBeNull();
  });
});
