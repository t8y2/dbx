// @vitest-environment happy-dom

// #15393：报告者反馈「报错信息看不出问题在哪」。本 spec 挂载真实设置对话框，
// 进入 AI 配置编辑态后点击页脚的「测试」按钮，断言失败时展示的是可行动的
// 分类说明（自建网关 5xx），而不是笼统的失败文本。

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { setLocale } from "@/i18n";
import { useSettingsStore } from "@/stores/settingsStore";
import EditorSettingsDialog from "@/components/editor/EditorSettingsDialog.vue";
import type { AiConfigItem } from "@/types/ai";

const backend = vi.hoisted(() => ({
  configs: [] as AiConfigItem[],
  testError: null as Error | null,
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
    aiTestConnection: async () => {
      if (backend.testError) throw backend.testError;
      return { success: true, message: "ok", latencyMs: 42, modelUsed: "test-model" };
    },
    webdavSyncSecretsStatus: async () => ({}),
    snippetSavedTokenStatus: async () => ({}),
    snippetSyncSettings: async () => ({}),
  };
});

let app: App | undefined;
let host: HTMLElement;

const fixtureConfig: AiConfigItem = {
  id: "cfg-15393",
  name: "自建网关",
  provider: "openai-compatible",
  apiKey: "sk-test",
  authMethod: "api-key",
  endpoint: "https://gateway.internal/v1",
  model: "internal-chat",
  apiStyle: "completions",
};

async function settle() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await nextTick();
  }
}

beforeEach(async () => {
  backend.configs = [{ ...fixtureConfig }];
  backend.testError = null;
  localStorage.clear();
  await setLocale("zh-CN");
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  document.body.innerHTML = "";
  app = undefined;
});

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === text);
}

async function openEditorAndTest() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useSettingsStore();
  await store.initEditorSettings();
  await store.initDesktopSettings();
  await store.reloadAiConfigs();
  host = document.createElement("div");
  document.body.append(host);
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

  // 进入编辑态（真实入口：列表行的「编辑」按钮）
  buttonWithText("编辑")?.click();
  await settle();
  // 页脚的「测试」按钮
  buttonWithText("测试")?.click();
  await settle();
}

describe("AI config edit-mode connection test error diagnostics (#15393)", () => {
  it("explains a gateway 5xx with an actionable category", async () => {
    backend.testError = new Error("[serverError] API error (HTTP 500: empty response body)");
    await openEditorAndTest();

    const text = host.textContent ?? "";
    expect(text).toContain("HTTP 500");
    // 分类说明：告诉用户这是服务端/网关问题，而不是笼统的失败
    expect(text).toContain("服务端");
    expect(text).not.toContain("未分类");
  });

  it("explains an authentication failure with the existing category", async () => {
    backend.testError = new Error("[auth] 身份验证失败：网关返回 401 Unauthorized");
    await openEditorAndTest();

    const text = host.textContent ?? "";
    expect(text).toContain("401");
    expect(text).toContain("API Key");
  });
});
