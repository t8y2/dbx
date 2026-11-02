// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { writeSyncMethod } from "@/lib/webdav/webdavAutoUploadConfig";
import { useSettingsStore } from "@/stores/settingsStore";
import EditorSettingsDialog from "../EditorSettingsDialog.vue";

const backend = vi.hoisted(() => ({ hasSavedPassphrase: false }));

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    loadEditorSettings: async () => null,
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
    webdavPasswordStatus: async () => ({}),
    snippetTokenStatus: async () => ({ hasSavedToken: false }),
    snippetPassphraseStatus: async () => ({ hasSavedPassphrase: backend.hasSavedPassphrase }),
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
  backend.hasSavedPassphrase = false;
  localStorage.clear();
  writeSyncMethod("snippet");
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  document.body.innerHTML = "";
  app = undefined;
});

async function mountSyncTab() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useSettingsStore();
  await store.initEditorSettings();
  await store.initDesktopSettings();
  host = document.createElement("div");
  document.body.append(host);
  app = createApp(
    defineComponent({
      setup: () => () => h(EditorSettingsDialog, { variant: "page", open: true, initialTab: "sync", "onUpdate:open": () => undefined }),
    }),
  );
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  await settle();
}

function passphraseInput() {
  const input = host.querySelector<HTMLInputElement>("#snippet-sync-passphrase");
  expect(input).toBeTruthy();
  return input!;
}

function passphraseToggle() {
  return passphraseInput().parentElement!.querySelector<HTMLButtonElement>("button");
}

describe("EditorSettingsDialog snippet passphrase toggle", () => {
  it("shows the toggle for a passphrase typed in this session", async () => {
    await mountSyncTab();
    expect(passphraseToggle()).toBeTruthy();
  });

  it("hides the toggle while the field only shows the saved-passphrase placeholder", async () => {
    backend.hasSavedPassphrase = true;
    await mountSyncTab();
    await vi.waitFor(() => expect(passphraseInput().placeholder).toBe("••••••••"), { timeout: 5000 });
    expect(passphraseToggle()).toBeNull();

    const input = passphraseInput();
    input.value = "new-passphrase";
    input.dispatchEvent(new Event("input"));
    await settle();
    passphraseToggle()!.click();
    await settle();
    expect(passphraseInput().type).toBe("text");
  });
});
