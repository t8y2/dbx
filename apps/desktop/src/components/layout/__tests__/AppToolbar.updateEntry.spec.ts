// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
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
  Button: { name: "ButtonStub", props: ["ariaLabel"], template: `<button :aria-label="ariaLabel"><slot /></button>` },
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
  default: { name: "ToolbarUpdateIconStub", template: `<span />` },
}));

import { useSettingsStore } from "@/stores/settingsStore";
import AppToolbar from "../AppToolbar.vue";

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
};

let pinia: ReturnType<typeof createPinia>;

function mount(props: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(AppToolbar, { ...defaultToolbarProps, ...props });
  app.use(pinia);
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      missingWarn: false,
      fallbackWarn: false,
      messages: { en: { toolbar: { theme: "Theme" }, settings: { title: "Settings" }, updates: { check: "Check for updates" } } },
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
    document.body.innerHTML = "";
  });

  it("shows the idle check-for-updates button while the toolbar item is enabled", async () => {
    const { host, unmount } = mount({ hasUpdateAvailable: false });
    await nextTick();
    expect(host.querySelector("[data-toolbar-update-trigger]")).not.toBeNull();
    unmount();
  });

  it("hides the update entry when the toolbar item is disabled, even while an update is available", async () => {
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.toolbarItems.checkUpdates = false;

    const { host, unmount } = mount({ hasUpdateAvailable: true });
    await nextTick();
    expect(host.querySelector("[data-toolbar-update-trigger]")).toBeNull();
    unmount();
  });

  it("keeps the update entry when the toolbar item is enabled and an update is available", async () => {
    const { host, unmount } = mount({ hasUpdateAvailable: true });
    await nextTick();
    expect(host.querySelector("[data-toolbar-update-trigger]")).not.toBeNull();
    unmount();
  });
});
