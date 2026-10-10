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
  Button: {
    name: "ButtonStub",
    props: ["ariaLabel", "variant", "size"],
    template: `<button :aria-label="ariaLabel"><slot /></button>`,
  },
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: { name: "TooltipStub", template: `<span><slot /></span>` },
  TooltipTrigger: { name: "TooltipTriggerStub", template: `<span><slot /></span>` },
  TooltipContent: { name: "TooltipContentStub", template: `<span><slot /></span>` },
}));
vi.mock("@/components/ui/LightDropdown.vue", () => ({
  default: {
    name: "LightDropdownStub",
    props: ["items"],
    template: `<div data-light-dropdown><button v-for="item in items" :key="item.value" :data-toolbar-menu-item="item.value">{{ item.label }}</button></div>`,
  },
}));
vi.mock("@/components/layout/WindowControls.vue", () => ({
  default: { name: "WindowControlsStub", template: `<div />` },
}));
vi.mock("@/components/export/ExportProgressPopover.vue", () => ({
  default: { name: "ExportProgressPopoverStub", template: `<div />` },
}));
vi.mock("@/components/layout/ToolbarUpdateIcon.vue", () => ({
  default: { name: "ToolbarUpdateIconStub", template: `<span data-toolbar-update-icon-stub />` },
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
          updates: {
            check: "Check for updates",
            updateAction: "Update",
          },
          settings: { title: "Settings" },
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

describe("AppToolbar checkUpdates visibility", () => {
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders check-updates trigger when toolbarItems.checkUpdates is true and hasUpdateAvailable is false", async () => {
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.toolbarItems.checkUpdates = true;

    const { host, unmount } = mount({ hasUpdateAvailable: false });
    await nextTick();

    const trigger = host.querySelector("[data-toolbar-update-trigger]");
    expect(trigger).not.toBeNull();
    expect(trigger?.hasAttribute("data-toolbar-update-action")).toBe(false);
    expect(host.querySelector("[data-toolbar-update-icon-stub]")).not.toBeNull();

    unmount();
  });

  it("renders update action button when toolbarItems.checkUpdates is true and hasUpdateAvailable is true", async () => {
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.toolbarItems.checkUpdates = true;

    const { host, unmount } = mount({ hasUpdateAvailable: true });
    await nextTick();

    const trigger = host.querySelector("[data-toolbar-update-trigger]");
    expect(trigger).not.toBeNull();
    expect(trigger?.hasAttribute("data-toolbar-update-action")).toBe(true);
    expect(trigger?.textContent).toContain("Update");

    unmount();
  });

  it("hides check-updates trigger when toolbarItems.checkUpdates is false and hasUpdateAvailable is false", async () => {
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.toolbarItems.checkUpdates = false;

    const { host, unmount } = mount({ hasUpdateAvailable: false });
    await nextTick();

    expect(host.querySelector("[data-toolbar-update-trigger]")).toBeNull();

    unmount();
  });

  it("hides update trigger when toolbarItems.checkUpdates is false even if hasUpdateAvailable is true", async () => {
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.toolbarItems.checkUpdates = false;

    const { host, unmount } = mount({ hasUpdateAvailable: true });
    await nextTick();

    expect(host.querySelector("[data-toolbar-update-trigger]")).toBeNull();

    unmount();
  });

  it("dynamically toggles update trigger when toolbarItems.checkUpdates changes", async () => {
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.toolbarItems.checkUpdates = true;

    const { host, unmount } = mount({ hasUpdateAvailable: true });
    await nextTick();

    expect(host.querySelector("[data-toolbar-update-trigger]")).not.toBeNull();

    // User disables "checkUpdates" in Settings -> Appearance -> Toolbar
    settingsStore.editorSettings.toolbarItems.checkUpdates = false;
    await nextTick();

    expect(host.querySelector("[data-toolbar-update-trigger]")).toBeNull();

    // User re-enables "checkUpdates"
    settingsStore.editorSettings.toolbarItems.checkUpdates = true;
    await nextTick();

    expect(host.querySelector("[data-toolbar-update-trigger]")).not.toBeNull();

    unmount();
  });
});
