// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useSettingsStore } from "@/stores/settingsStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import EditorSettingsDialog from "../EditorSettingsDialog.vue";

const backend = vi.hoisted(() => ({ saved: null as unknown }));

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    loadEditorSettings: async () => backend.saved,
    saveEditorSettings: async () => undefined,
    loadHistoryRetentionLimit: async () => 5000,
    loadMcpHistoryRetentionLimit: async () => 5000,
    loadMcpGlobalPolicy: async () => null,
    loadDesktopSettings: async () => null,
    loadAiConfigs: async () => [],
    loadAiConfig: async () => null,
    loadAiProviderConfigs: async () => ({}),
    loadAiChatSelection: async () => null,
    webdavSyncSecretsStatus: async () => ({}),
    snippetSavedTokenStatus: async () => ({}),
    snippetSyncSettings: async () => ({}),
    getAppSupportInfo: async () => {
      throw new Error("unavailable in tests");
    },
    listInstalledAgentsLocal: async () => [],
    checkMcpServerStatus: async () => {
      throw new Error("unavailable in tests");
    },
  };
});

let app: App | undefined;
let host: HTMLElement;

async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await nextTick();
  }
}

beforeEach(() => {
  backend.saved = null;
  localStorage.clear();
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  document.body.innerHTML = "";
  app = undefined;
});

async function mountSettings(variant: "page" | "dialog") {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useSettingsStore();
  await store.initEditorSettings();
  await store.initDesktopSettings();
  host = document.createElement("div");
  document.body.append(host);
  app = createApp(
    defineComponent({
      setup: () => () =>
        h(
          TooltipProvider,
          {},
          {
            default: () =>
              h(EditorSettingsDialog, {
                variant,
                open: true,
                initialTab: "editor",
                "onUpdate:open": () => undefined,
              }),
          },
        ),
    }),
  );
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  await settle();
  return { store };
}

async function switchTab(labelKey: string) {
  const label = i18n.global.t(labelKey);
  const button = Array.from(host.querySelectorAll(".settings-category-nav button")).find((item) => item.textContent?.trim() === label);
  expect(button, labelKey).toBeTruthy();
  button!.click();
  await settle();
}

function expectFooterOutsideScrollingBody(root: ParentNode) {
  const footers = root.querySelectorAll('[data-slot="dialog-footer"]');
  expect(footers.length).toBe(1);
  const footer = footers[0];
  const layout = root.querySelector(".settings-layout")!;
  expect(layout).toBeTruthy();
  // 核心回归契约：页脚必须在滚动主体（settings-layout）之外——原来它在内容列的
  // flex 堆叠内，搜索框+实时预览+页脚一旦超过视口换算高度就把它挤出窗口。
  expect(footer.closest(".settings-layout")).toBeNull();
  expect(footer.parentElement).toBe(layout.parentElement);
  expect(footer.previousElementSibling).toBe(layout);
}

// 回归（界面缩放 ≥165% 时 恢复默认/关闭/应用/应用并关闭 被挤出窗口外无法点击）：
// 每个分类的页脚都必须固定在滚动主体之外，且同一时刻只渲染一个。
describe("EditorSettingsDialog footer layout", () => {
  it.each([
    ["appearance", "settings.appearanceTab"],
    ["editor", "settings.editorTab"],
    ["ai", "settings.aiTab"],
    ["sync", "settings.syncTab"],
    ["mcp", "settings.mcpTab"],
    ["about", "settings.aboutTab"],
  ])("keeps the %s tab footer outside the scrolling body (page variant)", async (tab, labelKey) => {
    await mountSettings("page");
    if (tab !== "editor") await switchTab(labelKey);
    expectFooterOutsideScrollingBody(host);
  });

  it("places toolbar inside editor settings after SQL file, without adding sidebar entries", async () => {
    await mountSettings("page");
    const editor = host.querySelector('[data-settings-search-id="editor"]')!;
    const sqlFile = editor.querySelector('[data-settings-search-id="editor-sql-file"]')!;
    const toolbar = editor.querySelector('[data-settings-search-id="editor-toolbar"]')!;
    expect(toolbar.querySelector("[data-editor-toolbar-preferences]")).not.toBeNull();
    expect(sqlFile.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toolbar.previousElementSibling?.previousElementSibling).toBe(sqlFile);
    const heading = toolbar.querySelector("[data-editor-toolbar-heading]")!;
    expect(heading.textContent?.trim()).toBe(i18n.global.t("settings.editorToolbarPreferences"));
    expect(heading.className).toBe(sqlFile.firstElementChild?.className);
    expect(toolbar.textContent).not.toContain("执行按钮始终显示");
    expect(toolbar.textContent).not.toContain("可横向滚动查看全部操作");
    expect(host.querySelector("[data-settings-parent]")).toBeNull();
    expectFooterOutsideScrollingBody(host);
    await switchTab("settings.navigationTab");
    expect(host.querySelector("[data-editor-toolbar-preferences]")).toBeNull();
  });

  it("keeps the footer outside the scrolling body (dialog variant)", async () => {
    await mountSettings("dialog");
    const dialog = document.querySelector('[data-slot="dialog-content"]');
    expect(dialog).toBeTruthy();
    expectFooterOutsideScrollingBody(dialog!);
    expect(dialog!.classList.contains("grid-rows-[auto_minmax(0,1fr)_auto]")).toBe(true);
  });

  it("lets the editor live preview yield space instead of forcing the footer out", async () => {
    await mountSettings("page");
    const preview = host.querySelector<HTMLElement>("[data-editor-live-preview]")!;
    expect(preview).toBeTruthy();
    expect(preview.classList.contains("shrink-0")).toBe(false);
    expect(preview.classList.contains("min-h-0")).toBe(true);
  });
});
