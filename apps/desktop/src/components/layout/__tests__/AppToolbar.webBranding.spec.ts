// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockIsTauriRuntime = false;

vi.mock("@/lib/backend/tauriRuntime", () => ({
  isTauriRuntime: () => mockIsTauriRuntime,
}));
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
  themeMode: "light" as const,
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
          toolbar: {
            newConnection: "New Connection",
            newQuery: "New Query",
          },
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

describe("AppToolbar web branding (#8703, #11053)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.removeItem("dbx-right-toolbar-labels");
    mockIsTauriRuntime = false;
    pinia = createPinia();
    setActivePinia(pinia);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renders the DBX brand logo and title on web mode on the left by default", async () => {
    mockIsTauriRuntime = false;
    const { host, unmount } = mount();
    await nextTick();

    const brandEl = host.querySelector('[data-testid="web-brand-logo"]');
    expect(brandEl).not.toBeNull();
    expect(brandEl?.getAttribute("href")).toBe("https://dbxio.com");
    expect(brandEl?.getAttribute("target")).toBe("_blank");
    expect(brandEl?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(brandEl?.textContent).toContain("DBX");

    const logoImg = brandEl?.querySelector("img");
    expect(logoImg).not.toBeNull();
    expect(logoImg?.getAttribute("alt")).toBe("DBX");

    // Located at the very start of toolbar (left position)
    const toolbar = host.querySelector(".app-toolbar");
    expect(toolbar?.firstElementChild).toBe(brandEl);

    unmount();
  });

  it("renders the DBX brand logo on the right when configured (#11053)", async () => {
    mockIsTauriRuntime = false;
    const settingsStore = useSettingsStore();
    settingsStore.updateEditorSettings({ webLogoPosition: "right" });

    const { host, unmount } = mount();
    await nextTick();

    const brandEl = host.querySelector('[data-testid="web-brand-logo"]');
    expect(brandEl).not.toBeNull();
    expect(brandEl?.textContent).toContain("DBX");

    const toolbar = host.querySelector(".app-toolbar");
    const children = Array.from(toolbar?.children ?? []);
    const brandIndex = children.indexOf(brandEl as Element);

    // Should not be the first child (it was moved from left to right)
    expect(brandIndex).toBeGreaterThan(0);

    // Toolbar settings button should be after the brand logo
    const settingsBtn = host.querySelector('button[class*="toolbar-action-button"]');
    expect(settingsBtn).not.toBeNull();

    unmount();
  });

  it("does not render the brand logo when webLogoPosition is hidden (#11053)", async () => {
    mockIsTauriRuntime = false;
    const settingsStore = useSettingsStore();
    settingsStore.updateEditorSettings({ webLogoPosition: "hidden" });

    const { host, unmount } = mount();
    await nextTick();

    const brandEl = host.querySelector('[data-testid="web-brand-logo"]');
    expect(brandEl).toBeNull();

    unmount();
  });

  it("does not render the web DBX brand logo in desktop mode regardless of setting", async () => {
    mockIsTauriRuntime = true;
    const settingsStore = useSettingsStore();
    settingsStore.updateEditorSettings({ webLogoPosition: "right" });

    const { host, unmount } = mount();
    await nextTick();

    const brandEl = host.querySelector('[data-testid="web-brand-logo"]');
    expect(brandEl).toBeNull();

    unmount();
  });

  it("hides the main-window marker when multi-window tabs are disabled", async () => {
    mockIsTauriRuntime = true;
    const settings = useSettingsStore();
    settings.editorSettings.crossWindowTabDragPreviewEnabled = true;
    const { host, unmount } = mount({ workspaceWindowLabel: "main", workspaceWindowTargets: [{ label: "dbx-tab-child", title: "DBX" }] });
    await nextTick();
    expect(host.querySelector("[data-workspace-window-identity]")).not.toBeNull();
    settings.editorSettings.crossWindowTabDragPreviewEnabled = false;
    await nextTick();
    expect(host.querySelector("[data-workspace-window-identity]")).toBeNull();
    unmount();
  });

  it("hides the main-window menu when no child windows remain", async () => {
    mockIsTauriRuntime = true;
    const { host, unmount } = mount({ workspaceWindowLabel: "main" });
    await nextTick();
    expect(host.querySelector("[data-workspace-window-identity]")).toBeNull();
    unmount();
  });

  it("shows the window menu for an independent window", async () => {
    mockIsTauriRuntime = true;
    const { host, unmount } = mount({ workspaceWindowLabel: "dbx-tab-child", workspaceWindowTargets: [{ label: "main", title: "DBX" }] });
    await nextTick();
    expect(host.querySelector("[data-workspace-window-identity]")).not.toBeNull();
    unmount();
  });

  it("folds and restores labels progressively without changing the user's preference", async () => {
    localStorage.setItem("dbx-right-toolbar-labels", "true");
    const { host, unmount } = mount();
    const toolbar = host.querySelector<HTMLElement>(".app-toolbar")!;
    let width = 900;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.matches(".app-toolbar")) return parseFloat(this.style.width) || width;
      if (this.matches("[data-toolbar-right-actions]")) return this.closest<HTMLElement>(".app-toolbar")!.clientWidth - 400;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.matches(".app-toolbar")) return this.clientWidth;
      if (this.matches("[data-toolbar-right-actions]")) return 250 + this.querySelectorAll('[data-right-toolbar-label-visible="true"]').length * 75;
      return 0;
    });
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => expect(toolbar.dataset.rightToolbarLabels).toBe("partial"));
    const clone = vi.spyOn(toolbar, "cloneNode");
    const narrowCount = toolbar.querySelectorAll('[data-right-toolbar-label-visible="true"]').length;
    expect(localStorage.getItem("dbx-right-toolbar-labels")).toBe("true");
    width = 1150;
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => expect(toolbar.querySelectorAll('[data-right-toolbar-label-visible="true"]').length).toBeGreaterThan(narrowCount));
    expect(toolbar.dataset.rightToolbarLabels).toBe("partial");
    width = 1400;
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => expect(toolbar.dataset.rightToolbarLabels).toBe("true"));
    expect(clone).not.toHaveBeenCalled();
    useSettingsStore().editorSettings.toolbarItems.sqlLibrary = false;
    await vi.waitFor(() => expect(clone).toHaveBeenCalled());
    unmount();
  });

  it("does not observe the action wrapper that changes width during label transitions", async () => {
    const observe = vi.spyOn(ResizeObserver.prototype, "observe");
    const { host, unmount } = mount();
    const toolbar = host.querySelector<HTMLElement>(".app-toolbar")!;
    expect(observe).toHaveBeenCalledWith(toolbar);
    expect(observe).not.toHaveBeenCalledWith(toolbar.querySelector("[data-toolbar-right-actions]"));
    unmount();
  });

  it("keeps the user's icon-only preference when the window grows", async () => {
    const { host, unmount } = mount();
    const toolbar = host.querySelector<HTMLElement>(".app-toolbar")!;
    Object.defineProperties(toolbar, {
      clientWidth: { get: () => 1800 },
      scrollWidth: { get: () => 1800 },
    });
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await nextTick();
    expect(toolbar.dataset.rightToolbarLabels).toBe("false");
    unmount();
  });

  it("moves primary actions into More when the whole row still overflows, and restores them on growth", async () => {
    const { host, unmount } = mount();
    const toolbar = host.querySelector<HTMLElement>(".app-toolbar")!;
    let width = 760;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.matches(".app-toolbar") ? parseFloat(this.style.width) || width : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.matches(".app-toolbar") && this.querySelector('[data-toolbar-item="dataTransfer"]') ? Math.max(this.clientWidth, 1000) : this.clientWidth;
    });
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => expect(toolbar.querySelector('[data-toolbar-item="dataTransfer"]')).toBeNull());
    width = 1200;
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => expect(toolbar.querySelector('[data-toolbar-item="dataTransfer"]')).not.toBeNull());
    unmount();
  });
});
