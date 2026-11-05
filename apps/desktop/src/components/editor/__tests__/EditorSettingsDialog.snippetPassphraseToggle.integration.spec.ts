// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { writeSyncMethod } from "@/lib/webdav/webdavAutoUploadConfig";
import { useSettingsStore } from "@/stores/settingsStore";
import { writeSnippetAutoUploadFields, readSnippetAutoUploadConfig, writeSnippetRemoteContentHash, readSnippetSyncSecretPreferences, writeSnippetSyncSecretPreferences } from "@/lib/cloudSync/snippetAutoUploadConfig";
import EditorSettingsDialog from "../EditorSettingsDialog.vue";

const backend = vi.hoisted(() => ({ hasSavedPassphrase: false, hasSavedToken: false }));

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
    snippetTokenStatus: async () => ({ hasSavedToken: backend.hasSavedToken }),
    snippetPassphraseStatus: async () => ({ hasSavedPassphrase: backend.hasSavedPassphrase }),
    snippetSavedTokenStatus: async () => ({}),
    snippetSyncSettings: async () => ({ snippetId: "fixture-snippet" }),
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
  backend.hasSavedToken = false;
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

describe("snippet sync preference persistence", () => {
  it("restores automatic upload across remounts", async () => {
    backend.hasSavedToken = true;
    backend.hasSavedPassphrase = true;
    writeSnippetAutoUploadFields("github", undefined, { enabled: false, intervalMinutes: 30 });
    writeSnippetRemoteContentHash("github", undefined, "fixture-snippet", "fixture-hash");
    await mountSyncTab();
    const autoUpload = () =>
      Array.from(host.querySelectorAll("label"))
        .find((label) => label.textContent?.trim() === i18n.global.t("settings.syncSnippetAutoUpload"))!
        .querySelector<HTMLInputElement>("input")!;
    await vi.waitFor(() => expect(autoUpload().disabled).toBe(false));
    autoUpload().click();
    await vi.waitFor(() => expect(readSnippetAutoUploadConfig().enabled).toBe(true));
    expect(host.textContent).toBeTruthy();
    app!.unmount();
    host.remove();
    app = undefined;
    await mountSyncTab();
    expect(readSnippetAutoUploadConfig().enabled).toBe(true);
    expect(autoUpload().checked).toBe(true);
  });
  it("restores upload and download encrypted-secret selections after reopening", async () => {
    await mountSyncTab();
    const labels = () => Array.from(host.querySelectorAll("label")).filter((label) => /上传时包含|下载时恢复|Include encrypted|Restore encrypted/i.test(label.textContent || ""));
    expect(labels()).toHaveLength(2);
    for (const label of labels()) label.querySelector<HTMLInputElement>("input")!.click();
    await settle();
    app!.unmount();
    host.remove();
    app = undefined;
    await mountSyncTab();
    for (const label of labels()) expect(label.querySelector<HTMLInputElement>("input")!.checked).toBe(true);
  });
});

it("keeps encrypted-secret preferences scoped to the provider and GitLab instance", () => {
  writeSnippetSyncSecretPreferences("github", undefined, { includeSecrets: true, restoreSecrets: true });
  writeSnippetSyncSecretPreferences("gitlab", "https://gitlab.example/", { includeSecrets: true, restoreSecrets: false });
  expect(readSnippetSyncSecretPreferences("github")).toEqual({ includeSecrets: true, restoreSecrets: true });
  expect(readSnippetSyncSecretPreferences("gitee")).toEqual({ includeSecrets: false, restoreSecrets: false });
  expect(readSnippetSyncSecretPreferences("gitlab", "https://gitlab.example")).toEqual({ includeSecrets: true, restoreSecrets: false });
  expect(readSnippetSyncSecretPreferences("gitlab", "https://other.example")).toEqual({ includeSecrets: false, restoreSecrets: false });
});
