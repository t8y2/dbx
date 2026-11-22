// @vitest-environment happy-dom

// #15393: one-click AI connection test from the config list. The edit-mode
// footer already has a test button; this covers the list-row button reusing
// the same backend probe, with per-row status (latency / error).

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { setLocale } from "@/i18n";
import { useSettingsStore } from "@/stores/settingsStore";
import EditorSettingsDialog from "../EditorSettingsDialog.vue";
import type { AiConfigItem, AiTestConnectionResult } from "@/types/ai";

const backend = vi.hoisted(() => ({
  configs: [] as AiConfigItem[],
  testResult: null as AiTestConnectionResult | null,
  testError: null as Error | null,
  testCalls: [] as unknown[],
}));

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
    loadAiConfigs: async () => backend.configs,
    loadAiConfig: async () => null,
    loadAiProviderConfigs: async () => ({}),
    loadAiChatSelection: async () => null,
    loadPromptTemplates: async () => [],
    getAiGlobalCustomInstructions: async () => "",
    loadMaxAgentTurns: async () => 20,
    loadMaxRetries: async () => 3,
    aiTestConnection: async (config: unknown) => {
      backend.testCalls.push(config);
      if (backend.testError) throw backend.testError;
      return backend.testResult;
    },
    webdavSyncSecretsStatus: async () => ({}),
    snippetSavedTokenStatus: async () => ({}),
    snippetSyncSettings: async () => ({}),
  };
});

let app: App | undefined;
let host: HTMLElement;

const fixtureConfig: AiConfigItem = {
  id: "cfg-list-test",
  name: "列表测试配置",
  provider: "openai-compatible",
  apiKey: "sk-test",
  authMethod: "api-key",
  endpoint: "https://ai.example.test/v1",
  model: "test-model",
  apiStyle: "completions",
};

async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await nextTick();
  }
}

function rowTestButton(): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "测试");
}

beforeEach(() => {
  backend.configs = [{ ...fixtureConfig }];
  backend.testResult = null;
  backend.testError = null;
  backend.testCalls = [];
  localStorage.clear();
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  document.body.innerHTML = "";
  app = undefined;
});

async function mountAiSettings() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useSettingsStore();
  await store.initEditorSettings();
  await store.initDesktopSettings();
  // 真实应用里 AI 配置由启动流程加载；harness 不经过它，这里显式加载 fixture。
  await store.reloadAiConfigs();
  // happy-dom 下语言探测落到 en，且 settings 初始化可能重置 locale；
  // 在初始化全部完成后用应用自己的 setLocale 钉到 zh-CN。
  await setLocale("zh-CN");
  host = document.createElement("div");
  document.body.append(host);
  // 打开态由 false 翻转为 true，让 settingsVisible 的 open watch 真正触发
  // （挂载时已是 true 的 watch 无变化可观测，initialTab 不会被应用）。
  const dialogProps = reactive({ open: false, initialTab: "ai" });
  app = createApp(
    defineComponent({
      setup: () => () =>
        h(EditorSettingsDialog, {
          variant: "page",
          ...dialogProps,
          "onUpdate:open": (value: boolean) => {
            dialogProps.open = value;
          },
        }),
    }),
  );
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  await settle();
  dialogProps.open = true;
  await settle();
}

describe("EditorSettingsDialog AI config list test", () => {
  it("tests a saved config from the list and shows success with latency", async () => {
    backend.testResult = { success: true, message: "ok", latencyMs: 123, modelUsed: "test-model" };
    await mountAiSettings();

    const button = rowTestButton();
    expect(button, "list row should render a test button").toBeDefined();
    button!.click();
    await settle();

    expect(backend.testCalls).toHaveLength(1);
    expect(backend.testCalls[0]).toMatchObject({ id: fixtureConfig.id, model: fixtureConfig.model });

    const row = button!.closest("div")!;
    expect(row.textContent).toContain("连接成功");
    expect(row.textContent).toContain("123ms");
  });

  it("shows a per-row error with the categorized title when the probe fails", async () => {
    backend.testError = new Error("[auth] invalid api key");
    await mountAiSettings();

    const button = rowTestButton();
    button!.click();
    await settle();

    expect(backend.testCalls).toHaveLength(1);
    const row = button!.closest("div")!;
    expect(row.textContent).toContain("[auth] invalid api key");
    const errorSpan = [...row.querySelectorAll("span")].find((span) => span.textContent?.includes("[auth] invalid api key"));
    expect(errorSpan?.getAttribute("title")).toContain("invalid api key");
    // 失败后重试入口仍在且不再处于 testing 态
    expect(button!.disabled).toBe(false);
  });
});
