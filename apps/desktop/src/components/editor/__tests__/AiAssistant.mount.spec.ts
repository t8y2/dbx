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

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const empty = () => Promise.resolve([]);
  return {
    ...actual,
    loadAiConversations: empty,
    loadAiRuns: empty,
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
  while (cleanups.length) cleanups.pop()?.();
});

async function mountPanel(aiConfigLoaded: boolean, connection?: ConnectionConfig, configureSettings?: (settings: ReturnType<typeof useSettingsStore>) => void) {
  const pinia = createPinia();
  const errors: unknown[] = [];
  const app = createApp({ render: () => h(TooltipProvider, () => h(AiAssistant, { connection })) });
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
  });
});
