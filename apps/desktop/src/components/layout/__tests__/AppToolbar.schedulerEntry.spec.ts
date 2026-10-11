// @vitest-environment happy-dom
// The scheduler task center's primary entry lives on the app toolbar (plan §0
// "独立一级入口「计划任务」"). These specs pin the button's visibility switch and
// its emit so the entry cannot silently regress the way it did before.
import { createApp, nextTick, type Component } from "vue";
import { createPinia } from "pinia";
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
  showSchedulerPage: false,
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
const mountedHosts: Array<{ app: ReturnType<typeof createApp>; host: HTMLElement }> = [];

// AppToolbar reads toolbar visibility from the settings store, not from props.
function setToolbarItems(items: Record<string, boolean>) {
  const settingsStore = useSettingsStore(pinia);
  settingsStore.editorSettings.toolbarItems = { ...defaultSettingsToolbarItems(), ...items } as typeof settingsStore.editorSettings.toolbarItems;
}

function mount(props: Record<string, unknown>, onOpenSchedulerPage?: () => void) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(AppToolbar as Component, {
    ...defaultToolbarProps,
    ...props,
    onOpenSchedulerPage,
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
          toolbar: { pluginCenter: "Plugin Center" },
          scheduler: { title: "Scheduled Tasks" },
          common: { more: "More" },
          transfer: { dataTransfer: "Data Transfer" },
          sqlFile: { title: "SQL File" },
          diff: { title: "Schema Diff" },
          dataCompare: { title: "Data Compare" },
          databaseBackup: { title: "Database Backups" },
          settings: { openMcpSettings: "MCP Settings" },
        },
      },
    }),
  );
  app.mount(host);
  mountedHosts.push({ app, host });
  return host;
}

beforeEach(() => {
  pinia = createPinia();
  vi.spyOn(window.localStorage.__proto__, "getItem").mockReturnValue(null);
});

afterEach(() => {
  for (const { app, host } of mountedHosts.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.restoreAllMocks();
});

function schedulerButton(host: HTMLElement): HTMLButtonElement | null {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Scheduled Tasks")) ?? null;
}

describe("AppToolbar scheduler entry", () => {
  it("renders the scheduler toolbar button by default and emits open-scheduler-page on click", async () => {
    setToolbarItems({ scheduler: true });
    const onOpenSchedulerPage = vi.fn();
    const host = mount({}, onOpenSchedulerPage);
    await nextTick();

    const button = schedulerButton(host);
    expect(button).not.toBeNull();
    button!.click();
    expect(onOpenSchedulerPage).toHaveBeenCalledExactlyOnceWith();
  });

  it("hides the scheduler button when toolbarItems.scheduler is off", async () => {
    setToolbarItems({ scheduler: false });
    const host = mount({});
    await nextTick();

    expect(schedulerButton(host)).toBeNull();
  });

  it("marks the button active while the scheduler page is the active surface", async () => {
    setToolbarItems({ scheduler: true });
    const host = mount({ showSchedulerPage: true });
    await nextTick();

    expect(schedulerButton(host)!.className).toContain("bg-accent");
  });
});

function defaultSettingsToolbarItems() {
  return {
    immediateSync: false,
    dataTransfer: true,
    driverManager: true,
    pluginCenter: true,
    scheduler: true,
    sqlFile: true,
    schemaDiff: true,
    dataCompare: true,
    checkUpdates: true,
    sqlLibrary: true,
    sqlFileTree: true,
    history: true,
    ai: true,
    theme: true,
    github: true,
    alwaysOnTop: false,
    exclusiveRightSidebarPanels: true,
  };
}
