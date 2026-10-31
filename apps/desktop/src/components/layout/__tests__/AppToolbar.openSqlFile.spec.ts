// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => undefined) }));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: { template: "<span><slot /></span>" },
  TooltipTrigger: { template: "<span><slot /></span>" },
  TooltipContent: { template: "<span><slot /></span>" },
}));
vi.mock("@/components/layout/WindowControls.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/export/ExportProgressPopover.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/layout/ToolbarUpdateIcon.vue", () => ({ default: { template: "<span />" } }));
vi.mock("@/components/plugins/PluginShortcutToolbar.vue", () => ({ default: { template: "<div />" } }));

import AppToolbar from "../AppToolbar.vue";
import { useSettingsStore } from "@/stores/settingsStore";

const defaultToolbarProps = {
  isDark: false,
  themeMode: "system" as const,
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
let toolbarWidth = 1200;
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();

function mount(props: Record<string, unknown> = {}) {
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
      messages: {
        en: {
          common: { more: "More" },
          toolbar: { newConnection: "New connection", newQuery: "New query", openSql: "Open SQL file" },
          transfer: { dataTransfer: "Data transfer" },
          sqlFile: { title: "Execute SQL file" },
        },
      },
    }),
  );
  app.mount(host);
  mounted = {
    host,
    unmount: () => {
      app.unmount();
      host.remove();
    },
  };
  return host;
}

function buttonWithText(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === text);
}

async function flushLayout() {
  await nextTick();
  const pending = Array.from(frames.values());
  frames.clear();
  pending.forEach((callback) => callback(0));
  await nextTick();
}

describe("AppToolbar opens SQL files in the editor", () => {
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    toolbarWidth = 1200;
    frames.clear();
    vi.stubGlobal("visualViewport", { width: 1600 });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function () {
      return this.classList.contains("app-toolbar") ? toolbarWidth : 1000;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(1000);
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens a file without a connection or an available query tab", async () => {
    const openEditor = vi.fn();
    const executeFile = vi.fn();
    const host = mount({ onOpenSqlEditorFile: openEditor, onOpenSqlFile: executeFile });
    await flushLayout();

    expect(buttonWithText(host, "New query")).toBeUndefined();
    const openButton = buttonWithText(host, "Open SQL file");
    expect(openButton).toBeDefined();
    expect(openButton?.disabled).toBe(false);
    openButton!.click();

    expect(openEditor).toHaveBeenCalledOnce();
    expect(executeFile).not.toHaveBeenCalled();
  });

  it("keeps file opening available from More when the toolbar collapses", async () => {
    const openEditor = vi.fn();
    const host = mount({ onOpenSqlEditorFile: openEditor });
    await flushLayout();
    expect(buttonWithText(host, "Open SQL file")).toBeDefined();

    toolbarWidth = 400;
    window.dispatchEvent(new Event("resize"));
    await flushLayout();
    expect(buttonWithText(host, "Open SQL file")).toBeUndefined();
    buttonWithText(host, "More")!.click();
    await nextTick();

    const openItem = buttonWithText(document.body, "Open SQL file");
    expect(openItem?.getAttribute("role")).toBe("menuitem");
    expect(openItem?.disabled).toBe(false);
    openItem!.click();
    expect(openEditor).toHaveBeenCalledOnce();
  });

  it("moves only the file action into More in a narrow window and restores it when widened", async () => {
    useSettingsStore().editorSettings.toolbarItems.dataTransfer = true;
    vi.stubGlobal("visualViewport", { width: 760 });
    toolbarWidth = 722;
    const openEditor = vi.fn();
    const host = mount({ hasConnections: true, canNewQuery: true, onOpenSqlEditorFile: openEditor });
    await flushLayout();

    expect(buttonWithText(host, "Open SQL file")).toBeUndefined();
    expect(buttonWithText(host, "Data transfer")).toBeDefined();
    buttonWithText(host, "More")!.click();
    await nextTick();

    const openItem = buttonWithText(document.body, "Open SQL file");
    expect(openItem?.disabled).toBe(false);
    openItem!.click();
    expect(openEditor).toHaveBeenCalledOnce();

    toolbarWidth = 1200;
    window.dispatchEvent(new Event("resize"));
    await flushLayout();
    expect(buttonWithText(host, "Open SQL file")).toBeDefined();
    buttonWithText(host, "More")!.click();
    await nextTick();
    const menuItems = document.body.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]');
    expect(Array.from(menuItems).some((item) => item.textContent?.trim() === "Open SQL file")).toBe(false);
  });

  it("collapses primary controls in a very narrow window while keeping file opening in More", async () => {
    useSettingsStore().editorSettings.toolbarItems.dataTransfer = true;
    vi.stubGlobal("visualViewport", { width: 520 });
    toolbarWidth = 482;
    const openEditor = vi.fn();
    const host = mount({ hasConnections: true, canNewQuery: true, onOpenSqlEditorFile: openEditor });
    await flushLayout();

    expect(buttonWithText(host, "Open SQL file")).toBeUndefined();
    expect(buttonWithText(host, "Data transfer")).toBeUndefined();
    const moreButton = buttonWithText(host, "More");
    expect(moreButton).toBeDefined();
    moreButton!.click();
    await nextTick();

    expect(buttonWithText(document.body, "Data transfer")).toBeDefined();
    const openItem = buttonWithText(document.body, "Open SQL file");
    expect(openItem?.disabled).toBe(false);
    openItem!.click();
    expect(openEditor).toHaveBeenCalledOnce();
  });

  it("preserves the separate Execute SQL file action", async () => {
    useSettingsStore().editorSettings.toolbarItems.sqlFile = true;
    const openEditor = vi.fn();
    const executeFile = vi.fn();
    const host = mount({ hasConnections: true, hasSqlFileConnections: true, onOpenSqlEditorFile: openEditor, onOpenSqlFile: executeFile });
    await flushLayout();
    buttonWithText(host, "More")!.click();
    await nextTick();

    const executeItem = buttonWithText(document.body, "Execute SQL file");
    expect(executeItem?.disabled).toBe(false);
    executeItem!.click();
    expect(executeFile).toHaveBeenCalledOnce();
    expect(openEditor).not.toHaveBeenCalled();
  });
});
