// @vitest-environment happy-dom
//
// Mounted smoke test for the AI panel. The app loads the AI config at startup,
// so the panel normally mounts with `isAiConfigLoaded` already true and its
// `immediate` default-selection watcher runs during setup. That path once read
// `boundConnection` before it was declared, and the TDZ ReferenceError kept the
// panel from opening at all.
import { createApp, h } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import AiAssistant from "@/components/editor/AiAssistant.vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import type { ConnectionConfig } from "@/types/database";
import type { PluginAiRecommendationHostUpdate } from "@/lib/plugins/pluginHostBridge";

const aiAssistantMountApi = vi.hoisted(() => ({
  conversations: [] as Array<Record<string, unknown>>,
  runAgentStream: undefined as undefined | ((onEvent: (event: { type: string; delta?: string }) => void) => Promise<string>),
}));

vi.mock("@/lib/ai/ai", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runAgentStream: async (...args: unknown[]) => {
      const onEvent = args[2] as (event: { type: string; delta?: string }) => void;
      return aiAssistantMountApi.runAgentStream?.(onEvent) ?? "";
    },
  };
});

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const empty = () => Promise.resolve([]);
  return {
    ...actual,
    loadAiConversations: () => Promise.resolve(aiAssistantMountApi.conversations),
    loadAiRuns: empty,
    saveAiConversation: () => Promise.resolve(),
    readUserSkills: empty,
    loadAiConfigs: empty,
    listPlugins: empty,
    loadPromptTemplates: empty,
    getAiGlobalCustomInstructions: () => Promise.resolve(""),
    saveAiChatSelection: () => Promise.resolve(),
    loadAiChatSelection: () => Promise.resolve(null),
  };
});

const cleanups: Array<() => void> = [];

afterEach(() => {
  aiAssistantMountApi.conversations = [];
  aiAssistantMountApi.runAgentStream = undefined;
  while (cleanups.length) cleanups.pop()?.();
});

async function mountPanel(aiConfigLoaded: boolean, connection?: ConnectionConfig, configureSettings?: (settings: ReturnType<typeof useSettingsStore>) => void, pluginRecommendations?: PluginAiRecommendationHostUpdate) {
  const pinia = createPinia();
  const errors: unknown[] = [];
  const app = createApp({ render: () => h(TooltipProvider, () => h(AiAssistant, { connection, pluginRecommendations })) });
  app.use(pinia);
  app.use(i18n);
  app.config.errorHandler = (error) => errors.push(error);
  app.config.warnHandler = () => {};
  const settings = useSettingsStore(pinia);
  settings.isAiConfigLoaded = aiConfigLoaded;
  configureSettings?.(settings);
  if (connection) useConnectionStore(pinia).connections = [connection];
  const container = document.createElement("div");
  document.body.append(container);
  app.mount(container);
  cleanups.push(() => {
    app.unmount();
    container.remove();
  });
  // Let mount-time loads settle so their failures surface here too.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { errors, container };
}

describe("AiAssistant mount", () => {
  it("applies custom typography to restored message content and the prompt only", async () => {
    aiAssistantMountApi.conversations = [
      {
        id: "typography-conversation",
        title: "Typography",
        connectionName: "",
        connectionId: "",
        database: "",
        messages: [
          { role: "user", content: "User message" },
          { role: "assistant", content: "### Heading\n\nInline `value`.\n\n```sql\nSELECT 1\n```" },
        ],
        createdAt: "2026-09-27T00:00:00.000Z",
        updatedAt: "2026-09-27T00:00:00.000Z",
      },
    ];

    const { container, errors } = await mountPanel(true, undefined, (settings) => {
      settings.restoreLastConversation = true;
      settings.editorSettings.aiFontFamily = "Georgia, serif";
      settings.editorSettings.aiFontSize = 18;
    });

    const root = container.querySelector<HTMLElement>("[data-ai-assistant-root]");
    expect(root?.style.getPropertyValue("--dbx-ai-content-font-family")).toBe("Georgia, serif");
    expect(root?.style.getPropertyValue("--dbx-ai-content-font-size")).toBe("18px");
    expect(root?.style.getPropertyValue("--dbx-ai-code-font-size")).toBe("18px");
    expect(container.querySelector("[data-ai-user-message-content]")?.closest(".ai-conversation-text")).not.toBeNull();
    expect(container.querySelector("[data-ai-assistant-message-content]")?.classList.contains("ai-conversation-text")).toBe(true);
    expect(container.querySelector(".ai-markdown code")).not.toBeNull();
    expect(container.querySelector(".ai-code-block")).not.toBeNull();
    expect(container.querySelector("textarea.ai-conversation-text")).not.toBeNull();
    expect(container.firstElementChild?.firstElementChild?.classList.contains("ai-conversation-text")).toBe(false);
    expect(errors.map(String)).toEqual([]);
  });

  it("keeps the same typography scope while an answer streams and after it completes", async () => {
    let finishStream!: () => void;
    const streamPending = new Promise<void>((resolve) => {
      finishStream = resolve;
    });
    aiAssistantMountApi.runAgentStream = async (onEvent) => {
      onEvent({ type: "text_delta", delta: "**Streaming answer**" });
      await streamPending;
      onEvent({ type: "agent_end" });
      return "Streaming answer";
    };

    const recommendation = {
      pluginId: "sample.plugin",
      pluginName: "Sample",
      contributionId: "workbench",
      workbenchId: "cluster",
      context: { connectionId: "plugin-connection" },
      items: [{ id: "stream", label: "Stream answer", prompt: "Stream answer" }],
    };
    const { container, errors } = await mountPanel(
      true,
      { id: "plugin-connection", name: "Sample", db_type: "plugin", plugin_id: "sample.plugin", host: "localhost", port: 22, username: "", password: "" },
      (settings) => {
        settings.aiConfigs = [
          {
            id: "custom",
            name: "Custom",
            provider: "openai-compatible",
            apiKey: "test-key",
            authMethod: "api-key",
            endpoint: "https://example.com/v1",
            model: "test-model",
            apiStyle: "completions",
            isDefault: true,
          },
        ];
        settings.activeModel = { configId: "custom", modelId: "test-model" };
        settings.editorSettings.aiFontFamily = "Georgia, serif";
        settings.editorSettings.aiFontSize = 18;
      },
      recommendation,
    );

    container.querySelector<HTMLButtonElement>('button[title="Stream answer"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const streamingContent = container.querySelector<HTMLElement>("[data-ai-assistant-message-content]");
    expect(streamingContent?.classList.contains("ai-conversation-text")).toBe(true);
    expect(streamingContent?.textContent).toContain("Streaming answer");
    expect(container.querySelector("[data-ai-generation-status]")).not.toBeNull();

    finishStream();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const completedContent = container.querySelector<HTMLElement>("[data-ai-assistant-message-content]");
    expect(completedContent?.classList.contains("ai-conversation-text")).toBe(true);
    expect(completedContent?.textContent).toContain("Streaming answer");
    expect(container.querySelector("[data-ai-generation-status]")).toBeNull();
    expect(errors.map(String)).toEqual([]);
  });

  it("keeps the real Agent mode and an interactive picker after clicking a plugin recommendation", async () => {
    const { container, errors } = await mountPanel(
      true,
      { id: "plugin-connection", name: "Sample", db_type: "plugin", plugin_id: "sample.plugin", host: "localhost", port: 22, username: "", password: "" },
      (settings) => {
        settings.defaultAiMode = "agent";
      },
      {
        pluginId: "sample.plugin",
        pluginName: "Sample",
        contributionId: "workbench",
        workbenchId: "cluster",
        context: { connectionId: "plugin-connection" },
        items: [{ id: "overview", label: "Inspect cluster", prompt: "Inspect cluster" }],
      },
    );
    expect(container.querySelector(".ai-mode-action-trigger")?.textContent).toContain(i18n.global.t("ai.modes.agent"));
    container.querySelector<HTMLButtonElement>('button[title="Inspect cluster"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const trigger = container.querySelector<HTMLButtonElement>(".ai-mode-action-trigger");
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain(i18n.global.t("ai.modes.agent"));
    expect(container.querySelector(".ai-mode-static-trigger")).toBeNull();
    trigger!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    const askButton = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((button) => button.textContent?.trim() === i18n.global.t("ai.modes.ask"));
    expect(askButton).toBeDefined();
    askButton!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(trigger?.textContent).toContain(i18n.global.t("ai.modes.ask"));
    expect(errors.map(String)).toEqual([]);
  });

  it("opens when the AI config was loaded before the panel mounted", async () => {
    expect((await mountPanel(true)).errors.map(String)).toEqual([]);
  });

  it("opens while the AI config is still loading", async () => {
    expect((await mountPanel(false)).errors.map(String)).toEqual([]);
  });

  it("renders compactable composer controls with accessible labels", async () => {
    const { errors, container } = await mountPanel(true, undefined, (settings) => {
      settings.aiConfigs = [
        {
          id: "deepseek-default",
          name: "DeepSeek",
          provider: "deepseek",
          apiKey: "test-key",
          authMethod: "api-key",
          endpoint: "https://api.deepseek.com",
          model: "deepseek-chat",
          apiStyle: "completions",
          isDefault: true,
        },
      ];
      settings.activeModel = { configId: "deepseek-default", modelId: "deepseek-chat" };
    });

    expect(errors.map(String)).toEqual([]);
    expect(container.querySelector(".ai-prompt-context-container")).not.toBeNull();
    expect(container.querySelector("[data-ai-composer-actions]")).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".ai-template-selector-trigger")?.getAttribute("aria-label")).toBeTruthy();
    expect(container.querySelector<HTMLButtonElement>(".ai-skills-selector-trigger")?.getAttribute("aria-label")).toBe(i18n.global.t("ai.skillsEntry"));

    const modeTrigger = container.querySelector<HTMLButtonElement>(".ai-mode-action-trigger");
    expect(modeTrigger?.getAttribute("aria-label")).toBeTruthy();
    expect(modeTrigger?.getAttribute("title")).toBe(modeTrigger?.getAttribute("aria-label"));

    const modelTrigger = container.querySelector<HTMLButtonElement>(".ai-model-selector-trigger");
    expect(modelTrigger?.getAttribute("aria-label")).toBe("deepseek-chat");
    expect(modelTrigger?.getAttribute("title")).toBe("deepseek-chat");
  });

  it.each(["plugin", "etcd"] as const)("hides database and schema selectors for %s connections", async (dbType) => {
    const { errors, container } = await mountPanel(true, { id: "connection", name: "Connection", db_type: dbType, plugin_id: dbType === "plugin" ? "sample.plugin" : undefined, host: "localhost", port: 22, username: "", password: "" });
    expect(errors.map(String)).toEqual([]);
    const row = container.querySelector("[data-ai-composer-context-row]");
    expect(row?.textContent).toContain("Connection");
    expect(row?.textContent).not.toContain(i18n.global.t("editor.selectDatabase"));
    expect(row?.classList.contains("ai-prompt-context-row--schema")).toBe(false);
  });

  it("keeps database and schema selectors for PostgreSQL", async () => {
    const { errors, container } = await mountPanel(true, { id: "postgres", name: "PostgreSQL", db_type: "postgres", host: "localhost", port: 5432, username: "", password: "" });
    expect(errors.map(String)).toEqual([]);
    const row = container.querySelector("[data-ai-composer-context-row]");
    expect(row?.textContent).toContain(i18n.global.t("editor.selectDatabase"));
    expect(row?.classList.contains("ai-prompt-context-row--schema")).toBe(true);
    const databaseTrigger = container.querySelector<HTMLButtonElement>(".ai-database-selector-trigger");
    expect(databaseTrigger?.getAttribute("aria-label")).toBeTruthy();
    expect(databaseTrigger?.querySelector(".ai-database-selector-icon")).not.toBeNull();
  });
});
