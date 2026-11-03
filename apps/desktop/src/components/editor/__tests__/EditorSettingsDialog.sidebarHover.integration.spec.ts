// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useSettingsStore } from "@/stores/settingsStore";
import EditorSettingsDialog from "../EditorSettingsDialog.vue";
import { TooltipProvider } from "@/components/ui/tooltip";

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
        h(TooltipProvider, null, {
          default: () =>
            h(EditorSettingsDialog, {
              variant,
              open: true,
              initialTab: "navigation",
              "onUpdate:open": () => undefined,
            }),
        }),
    }),
  );
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  await settle();
  return { store };
}

describe("sidebar hover settings", () => {
  it("applies both controls, preserves delay when disabled, and restores navigation defaults", async () => {
    const { store } = await mountSettings("page");
    const input = () => host.querySelector<HTMLInputElement>("#sidebar-hover-delay")!;
    const toggle = () => host.querySelector<HTMLButtonElement>("#sidebar-hover-enabled")!;
    const clickAction = async (key: string) => {
      const label = i18n.global.t(key);
      const button = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-footer"] button')).find((item) => item.textContent?.trim() === label);
      expect(button, key).toBeTruthy();
      button!.click();
      await settle();
    };
    expect(input().value).toBe("300");
    expect(input().min).toBe("100");
    expect(input().max).toBe("2000");
    input().value = "750";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    toggle().click();
    await settle();
    expect(input().disabled).toBe(true);
    expect(input().value).toBe("750");
    expect(store.editorSettings.sidebarHoverEnabled).toBe(true);
    await clickAction("settings.apply");
    expect(store.editorSettings).toMatchObject({ sidebarHoverEnabled: false, sidebarHoverDelay: 750 });
    toggle().click();
    await settle();
    input().value = "9999";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    await clickAction("settings.apply");
    expect(input().value).toBe("2000");
    expect(store.editorSettings.sidebarHoverDelay).toBe(2000);
    await clickAction("settings.resetDefaults");
    expect(input().disabled).toBe(false);
    expect(input().value).toBe("300");
    await clickAction("settings.apply");
    expect(store.editorSettings).toMatchObject({ sidebarHoverEnabled: true, sidebarHoverDelay: 300 });
  });
});
