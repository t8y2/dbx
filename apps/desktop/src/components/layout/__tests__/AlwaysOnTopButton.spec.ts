// @vitest-environment happy-dom
import { createApp, nextTick, type Component } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";

const windowState = vi.hoisted(() => ({ label: "main", alwaysOnTop: false }));
const listeners = vi.hoisted(() => [] as Array<{ event: string; unlisten: () => void }>);

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string) => {
    const entry = { event, unlisten: () => {} };
    entry.unlisten = () => {
      const index = listeners.indexOf(entry);
      if (index >= 0) listeners.splice(index, 1);
    };
    listeners.push(entry);
    return entry.unlisten;
  }),
  emit: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getAllWebviewWindows: vi.fn(async () => []),
  WebviewWindow: { getByLabel: vi.fn(async () => null) },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: windowState.label,
    isMaximized: async () => false,
    isFullscreen: async () => false,
    isAlwaysOnTop: async () => windowState.alwaysOnTop,
    setAlwaysOnTop: async (value: boolean) => {
      windowState.alwaysOnTop = value;
    },
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
  default: { name: "ToolbarUpdateIconStub", template: `<span />` },
}));

import AppToolbar from "../AppToolbar.vue";
import DetachedTabHeader from "../DetachedTabHeader.vue";
import { useSettingsStore } from "@/stores/settingsStore";

const PIN_ON_LABEL = "pin-window";
const PIN_OFF_LABEL = "unpin-window";
const ALWAYS_ON_TOP_EVENT = "dbx:window-always-on-top-changed";

let pinia: ReturnType<typeof createPinia>;

function mount(component: Component, props: Record<string, unknown>): { host: HTMLDivElement; unmount: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(component, props);
  app.use(pinia);
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      missingWarn: false,
      fallbackWarn: false,
      messages: { en: { toolbar: { alwaysOnTop: PIN_ON_LABEL, alwaysOnTopOff: PIN_OFF_LABEL } } },
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

/** The window state sync runs after the component mounts, so wait for it before touching the DOM. */
async function settled(): Promise<void> {
  await vi.waitFor(() => {
    expect(listeners.some((listener) => listener.event === ALWAYS_ON_TOP_EVENT)).toBe(true);
  });
}

function pinButton(host: HTMLElement, label: string = PIN_ON_LABEL): Element | null {
  return host.querySelector(`[aria-label="${label}"]`);
}

function clickPin(host: HTMLElement, label: string = PIN_ON_LABEL): void {
  const button = pinButton(host, label);
  expect(button).not.toBeNull();
  button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

const toolbarProps = {
  isDark: false,
  themeMode: "light",
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

describe("always-on-top button visibility", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    listeners.length = 0;
    windowState.label = "main";
    windowState.alwaysOnTop = false;
    pinia = createPinia();
    setActivePinia(pinia);
  });

  it("hides the main toolbar pin control until the appearance setting opts in", async () => {
    const settingsStore = useSettingsStore();
    const { host, unmount } = mount(AppToolbar, toolbarProps);
    await settled();

    expect(pinButton(host)).toBeNull();

    settingsStore.editorSettings.toolbarItems.alwaysOnTop = true;
    await nextTick();

    expect(pinButton(host)).not.toBeNull();
    expect(pinButton(host, PIN_OFF_LABEL)).toBeNull();

    unmount();
  });

  it("hides the detached window pin control until the appearance setting opts in", async () => {
    const settingsStore = useSettingsStore();
    const { host, unmount } = mount(DetachedTabHeader, { title: "SQL" });
    await settled();

    expect(pinButton(host)).toBeNull();

    settingsStore.editorSettings.toolbarItems.alwaysOnTop = true;
    await nextTick();

    expect(pinButton(host)).not.toBeNull();

    unmount();
  });

  it("keeps the pin control reachable while the window is pinned so it can be unpinned again", async () => {
    const settingsStore = useSettingsStore();
    const { host, unmount } = mount(AppToolbar, toolbarProps);
    await settled();

    settingsStore.editorSettings.toolbarItems.alwaysOnTop = true;
    await nextTick();
    expect(pinButton(host)).not.toBeNull();

    clickPin(host);
    await vi.waitFor(() => expect(windowState.alwaysOnTop).toBe(true));
    await vi.waitFor(() => expect(pinButton(host, PIN_OFF_LABEL)).not.toBeNull());

    // Turning the setting off while the window is pinned must not strand the
    // user with a pinned window and no control left to undo it.
    settingsStore.editorSettings.toolbarItems.alwaysOnTop = false;
    await nextTick();
    expect(pinButton(host, PIN_OFF_LABEL)).not.toBeNull();

    clickPin(host, PIN_OFF_LABEL);
    await vi.waitFor(() => expect(windowState.alwaysOnTop).toBe(false));
    await vi.waitFor(() => expect(pinButton(host, PIN_OFF_LABEL)).toBeNull());

    unmount();
  });
});
