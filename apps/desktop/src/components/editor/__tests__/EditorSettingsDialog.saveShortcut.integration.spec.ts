// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useSettingsStore } from "@/stores/settingsStore";
import EditorSettingsDialog from "../EditorSettingsDialog.vue";

const backend = vi.hoisted(() => ({ saved: null as unknown, saves: vi.fn() }));

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    loadEditorSettings: async () => backend.saved,
    saveEditorSettings: async (value: unknown) => {
      backend.saved = structuredClone(value);
      backend.saves(value);
    },
    loadHistoryRetentionLimit: async () => 5000,
    loadMcpHistoryRetentionLimit: async () => 5000,
    loadMcpGlobalPolicy: async () => null,
    loadWebMcpHttpStatus: async () => ({ enabled: false, allowedHosts: [], allowedOrigins: [] }),
    loadDesktopSettings: async () => null,
    saveDesktopSettings: async () => undefined,
    loadAiConfigs: async () => [],
    loadAiConfig: async () => null,
    loadAiProviderConfigs: async () => ({}),
    loadAiChatSelection: async () => null,
    webdavSyncSecretsStatus: async () => ({}),
    snippetTokenStatus: async () => ({ hasSavedToken: false }),
    snippetPassphraseStatus: async () => ({ hasSavedPassphrase: false }),
    snippetSyncSettings: async () => ({}),
    listPlugins: async () => [],
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
  backend.saves.mockClear();
  localStorage.clear();
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  document.body.innerHTML = "";
});

async function mountPage() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useSettingsStore();
  await store.initEditorSettings();
  await store.initDesktopSettings();
  backend.saves.mockClear();
  const page = ref<{ requestClose(): void; applySettingsFromShortcut(): Promise<void> } | null>(null);
  const open = ref(true);
  host = document.createElement("div");
  document.body.append(host);
  app = createApp(
    defineComponent({
      setup: () => () =>
        open.value
          ? h(EditorSettingsDialog, {
              ref: page,
              variant: "page",
              open: true,
              initialTab: "editor",
              "onUpdate:open": (value: boolean) => {
                open.value = value;
              },
            })
          : null,
    }),
  );
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  await settle();
  const changeFontSize = async () => {
    const input = host.querySelector<HTMLInputElement>('input[type="range"][min="10"][max="24"]')!;
    input.value = "19";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
  };
  return { page, open, store, changeFontSize };
}

describe("Ctrl+S on the settings page (exposed apply entrypoint)", () => {
  // The shortcut means "save", not "save and quit": App.vue routes Ctrl+S here
  // while the settings page owns the window, so a dirty draft must be persisted
  // without closing the page (#13020).
  it("persists a dirty draft without closing the page", async () => {
    const { page, open, store, changeFontSize } = await mountPage();
    const originalFontSize = store.editorSettings.fontSize;
    expect(originalFontSize).not.toBe(19);
    await changeFontSize();

    await page.value!.applySettingsFromShortcut();
    await settle();

    expect(store.editorSettings.fontSize).toBe(19);
    expect(backend.saves).toHaveBeenCalled();
    expect(open.value).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[type="range"][min="10"][max="24"]')?.value).toBe("19");
  });

  it("does nothing at all when there is no draft change", async () => {
    const { page, open } = await mountPage();

    await page.value!.applySettingsFromShortcut();
    await settle();

    expect(backend.saves).not.toHaveBeenCalled();
    expect(open.value).toBe(true);
  });
});

describe("connection group path setting", () => {
  it("applies both toggle values and reloads them when old settings have no field", async () => {
    backend.saved = {};
    const { store } = await mountPage();
    const toggle = host.querySelector<HTMLButtonElement>("#editor-show-connection-group-path")!;
    const apply = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === i18n.global.t("settings.apply"))!;

    expect(store.editorSettings.showConnectionGroupPath).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(apply.disabled).toBe(true);

    for (const enabled of [true, false]) {
      backend.saves.mockClear();
      toggle.click();
      await settle();
      expect(toggle.getAttribute("aria-checked")).toBe(String(enabled));
      expect(apply.disabled).toBe(false);

      apply.click();
      await settle();
      expect(store.editorSettings.showConnectionGroupPath).toBe(enabled);
      expect(backend.saves).toHaveBeenCalledWith(expect.objectContaining({ showConnectionGroupPath: enabled }));
      expect(apply.disabled).toBe(true);

      const reloadedStore = useSettingsStore(createPinia());
      await reloadedStore.initEditorSettings();
      expect(reloadedStore.editorSettings.showConnectionGroupPath).toBe(enabled);
    }
  });
});
