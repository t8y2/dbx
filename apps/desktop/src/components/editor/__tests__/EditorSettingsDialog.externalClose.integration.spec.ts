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
    loadDesktopSettings: async () => null,
    loadAiConfigs: async () => [],
    loadAiConfig: async () => null,
    loadAiProviderConfigs: async () => ({}),
    loadAiChatSelection: async () => null,
    webdavSyncSecretsStatus: async () => ({}),
    snippetSavedTokenStatus: async () => ({}),
    snippetSyncSettings: async () => ({}),
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
  const page = ref<{ requestClose(): void } | null>(null);
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

function clickText(key: string) {
  const text = i18n.global.t(key);
  const button = Array.from(document.querySelectorAll("button")).find((item) => item.textContent?.trim() === text);
  expect(button, key).toBeTruthy();
  button!.click();
}

describe("settings page external close request", () => {
  it("keeps a dirty draft when continuing, and closes without saving only after discarding", async () => {
    const { page, open, store, changeFontSize } = await mountPage();
    const originalFontSize = store.editorSettings.fontSize;
    await changeFontSize();
    page.value!.requestClose();
    await settle();
    expect(open.value).toBe(true);
    clickText("settings.unsavedChangesCloseCancel");
    await settle();
    expect(host.querySelector<HTMLInputElement>('input[type="range"][min="10"][max="24"]')?.value).toBe("19");
    expect(backend.saves).not.toHaveBeenCalled();
    page.value!.requestClose();
    await settle();
    clickText("settings.unsavedChangesCloseDiscard");
    await settle();
    expect(open.value).toBe(false);
    expect(store.editorSettings.fontSize).toBe(originalFontSize);
    expect(backend.saves).not.toHaveBeenCalled();
  });

  it("closes an unchanged page directly", async () => {
    const { page, open } = await mountPage();
    page.value!.requestClose();
    await settle();
    expect(open.value).toBe(false);
    expect(backend.saves).not.toHaveBeenCalled();
  });

  it("closes directly after applying the draft", async () => {
    const { page, open, store, changeFontSize } = await mountPage();
    await changeFontSize();
    clickText("settings.apply");
    await settle();
    expect(store.editorSettings.fontSize).toBe(19);
    expect(backend.saves).toHaveBeenCalled();
    page.value!.requestClose();
    await settle();
    expect(open.value).toBe(false);
  });
});
