// @vitest-environment happy-dom
//
// Mounted smoke test for the AI panel. The app loads the AI config at startup,
// so the panel normally mounts with `isAiConfigLoaded` already true and its
// `immediate` default-selection watcher runs during setup. That path once read
// `boundConnection` before it was declared, and the TDZ ReferenceError kept the
// panel from opening at all.
import { createApp, h, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import AiAssistant from "@/components/editor/AiAssistant.vue";
import { beginPanelResize, endPanelResize } from "@/lib/app/panelResizeState";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import type { ConnectionConfig } from "@/types/database";
import type { PluginAiRecommendationHostUpdate } from "@/lib/plugins/pluginHostBridge";
import type { AiExternalContextRequest } from "@/lib/ai/aiExternalContext";
import type { AiContext, AiRequestInput } from "@/lib/ai/ai";
import { buildAgentRequest } from "@/lib/ai/ai";
import { AI_SELECTION_CONTEXT_MAX_CHARS } from "@/lib/ai/aiAttachments";

const aiAssistantMountApi = vi.hoisted(() => ({
  conversations: [] as Array<Record<string, unknown>>,
  runAgentStream: undefined as undefined | ((onEvent: (event: { type: string; delta?: string }) => void) => Promise<string>),
  // #10058: the request the panel actually hands to the backend, and every
  // conversation record it asks to persist. Asserting on the outgoing request is
  // the only way to show a selection/binding was applied *before* the send.
  runAgentStreamInputs: [] as unknown[],
  // Second argument: the model-facing history the panel built for that request.
  runAgentStreamHistories: [] as unknown[],
  savedConversations: [] as Array<Record<string, unknown>>,
  codeHighlighterDelayMs: 0,
}));

// `onMounted` imports the syntax highlighter lazily; this module-level delay stands in for the
// loaded CI runner where that import resolves well after the DOM is ready.
vi.mock("@/lib/ai/aiCodeHighlighter", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createAiShikiCodeHighlighter: async (...args: unknown[]) => {
      const delay = aiAssistantMountApi.codeHighlighterDelayMs;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      return (actual.createAiShikiCodeHighlighter as (...innerArgs: unknown[]) => Promise<unknown>)(...args);
    },
  };
});

vi.mock("@/lib/ai/ai", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runAgentStream: async (...args: unknown[]) => {
      aiAssistantMountApi.runAgentStreamInputs.push(args[0]);
      aiAssistantMountApi.runAgentStreamHistories.push(args[1]);
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
    saveAiConversation: (conversation: Record<string, unknown>) => {
      aiAssistantMountApi.savedConversations.push(conversation);
      return Promise.resolve();
    },
    readUserSkills: empty,
    loadAiConfigs: empty,
    listPlugins: empty,
    loadPromptTemplates: empty,
    getAiGlobalCustomInstructions: () => Promise.resolve(""),
    saveAiChatSelection: () => Promise.resolve(),
    loadAiChatSelection: () => Promise.resolve(null),
    // Metadata reads a real send performs before `runAgentStream`. Without these
    // the panel would hit the HTTP backend inside happy-dom and the request
    // would never leave, which is exactly the moment under test.
    listSchemas: empty,
    listTables: empty,
    getColumns: empty,
    listIndexes: empty,
    listForeignKeys: empty,
  };
});

const cleanups: Array<() => void> = [];

afterEach(() => {
  endPanelResize();
  vi.unstubAllGlobals();
  aiAssistantMountApi.conversations = [];
  aiAssistantMountApi.runAgentStream = undefined;
  aiAssistantMountApi.runAgentStreamInputs = [];
  aiAssistantMountApi.runAgentStreamHistories = [];
  aiAssistantMountApi.savedConversations = [];
  aiAssistantMountApi.codeHighlighterDelayMs = 0;
  while (cleanups.length) cleanups.pop()?.();
});

function stubResizeObserver(): Array<{ callback: ResizeObserverCallback; targets: Element[] }> {
  const observers: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      callback: ResizeObserverCallback;
      targets: Element[] = [];

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        observers.push(this as unknown as { callback: ResizeObserverCallback; targets: Element[] });
      }

      observe(target: Element) {
        this.targets.push(target);
      }

      unobserve() {}
      disconnect() {}
    },
  );
  return observers;
}

async function mountPanel(aiConfigLoaded: boolean, connection?: ConnectionConfig, configureSettings?: (settings: ReturnType<typeof useSettingsStore>) => void, pluginRecommendations?: PluginAiRecommendationHostUpdate, extraConnections: ConnectionConfig[] = []) {
  const pinia = createPinia();
  const errors: unknown[] = [];
  const panelRef = ref<{ openExternalContext: (request: AiExternalContextRequest) => void } | null>(null);
  const app = createApp({ render: () => h(TooltipProvider, () => h(AiAssistant, { ref: panelRef, connection, pluginRecommendations })) });
  app.use(pinia);
  app.use(i18n);
  app.config.errorHandler = (error) => errors.push(error);
  app.config.warnHandler = () => {};
  const settings = useSettingsStore(pinia);
  settings.isAiConfigLoaded = aiConfigLoaded;
  configureSettings?.(settings);
  if (connection) useConnectionStore(pinia).connections = [connection, ...extraConnections];
  const container = document.createElement("div");
  document.body.append(container);
  app.mount(container);
  cleanups.push(() => {
    app.unmount();
    container.remove();
  });
  // Let mount-time loads settle so their failures surface here too.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { errors, container, panelRef };
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

  // These states settle through requestAnimationFrame plus async measurement, and the component
  // measures asynchronously, so they can lag the DOM. Budget by event-loop turns rather than
  // wall-clock: a CI worker's event loop can stall for seconds behind another worker's module
  // transforms (see `vitest.config.ts`), and a time-based budget trips in that window even though
  // the component is still progressing.
  async function waitForSettled(what: string, settled: () => boolean, diagnose: () => string): Promise<void> {
    for (let turn = 0; turn < 500; turn += 1) {
      if (settled()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (settled()) return;
    throw new Error(`${what} did not settle in time: ${diagnose()}`);
  }

  function configureDeepseekModel(settings: ReturnType<typeof useSettingsStore>): void {
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
  }

  it("wires panel size handling before the async mount bootstrap resolves", async () => {
    const resizeObservers = stubResizeObserver();
    aiAssistantMountApi.codeHighlighterDelayMs = 1000;

    const { errors, container } = await mountPanel(true, undefined, configureDeepseekModel);

    const panel = container.querySelector<HTMLElement>(".ai-prompt-context-container");
    expect(panel).not.toBeNull();
    // The bootstrap is still pending here, so the panel can only be observed if the wiring runs
    // synchronously: a drag or window resize during the bootstrap must not be dropped.
    expect(resizeObservers.some((observer) => observer.targets.includes(panel!))).toBe(true);
    expect(errors.map(String)).toEqual([]);
  });

  it("progressively compacts and expands composer controls while the AI panel is dragged", async () => {
    const resizeObservers = stubResizeObserver();
    const { errors, container } = await mountPanel(true, undefined, configureDeepseekModel);

    const panel = container.querySelector<HTMLElement>(".ai-prompt-context-container")!;
    const contextRow = container.querySelector<HTMLElement>("[data-ai-composer-context-row]")!;
    const actionRow = container.querySelector<HTMLElement>("[data-ai-composer-actions]")!;
    // Size handling is wired synchronously, so the panel is already observed here; driving a
    // resize must never be a no-op that leaves the compact classes unset.
    expect(resizeObservers.some((observer) => observer.targets.includes(panel))).toBe(true);
    // Other subtrees also build ResizeObservers; drive the one that watches this panel.
    const panelObserver = resizeObservers.find((observer) => observer.targets.includes(panel))!;
    const compactState = () => `context="${contextRow.className}" actions="${actionRow.className}"`;
    let panelWidth = 300;
    let contextClientWidth = 280;
    let contextScrollWidth = 320;
    let actionClientWidth = 280;
    let actionFullScrollWidth = 320;
    let actionModelCompactScrollWidth = 280;
    Object.defineProperty(panel, "clientWidth", { configurable: true, get: () => panelWidth });
    Object.defineProperty(contextRow, "clientWidth", { configurable: true, get: () => contextClientWidth });
    Object.defineProperty(contextRow, "scrollWidth", { configurable: true, get: () => contextScrollWidth });
    Object.defineProperty(actionRow, "clientWidth", { configurable: true, get: () => actionClientWidth });
    Object.defineProperty(actionRow, "scrollWidth", {
      configurable: true,
      get: () => (actionRow.classList.contains("ai-prompt-action-row--model-compact") ? actionModelCompactScrollWidth : actionFullScrollWidth),
    });

    beginPanelResize();
    panelObserver.callback([{ target: panel, contentRect: { width: panelWidth } } as ResizeObserverEntry], panelObserver as unknown as ResizeObserver);
    await waitForSettled("composer compact state", () => contextRow.classList.contains("ai-prompt-context-row--compact") && actionRow.classList.contains("ai-prompt-action-row--model-compact") && !actionRow.classList.contains("ai-prompt-action-row--mode-compact"), compactState);

    expect(contextRow.classList.contains("ai-prompt-context-row--compact")).toBe(true);
    expect(actionRow.classList.contains("ai-prompt-action-row--model-compact")).toBe(true);
    expect(actionRow.classList.contains("ai-prompt-action-row--mode-compact")).toBe(false);

    panelWidth = 240;
    actionClientWidth = 220;
    actionModelCompactScrollWidth = 250;
    panelObserver.callback([{ target: panel, contentRect: { width: panelWidth } } as ResizeObserverEntry], panelObserver as unknown as ResizeObserver);
    await waitForSettled("composer compact state", () => actionRow.classList.contains("ai-prompt-action-row--model-compact") && actionRow.classList.contains("ai-prompt-action-row--mode-compact"), compactState);
    expect(actionRow.classList.contains("ai-prompt-action-row--model-compact")).toBe(true);
    expect(actionRow.classList.contains("ai-prompt-action-row--mode-compact")).toBe(true);

    panelWidth = 300;
    actionClientWidth = 280;
    actionModelCompactScrollWidth = 280;
    panelObserver.callback([{ target: panel, contentRect: { width: panelWidth } } as ResizeObserverEntry], panelObserver as unknown as ResizeObserver);
    await waitForSettled("composer compact state", () => actionRow.classList.contains("ai-prompt-action-row--model-compact") && !actionRow.classList.contains("ai-prompt-action-row--mode-compact"), compactState);
    expect(actionRow.classList.contains("ai-prompt-action-row--model-compact")).toBe(true);
    expect(actionRow.classList.contains("ai-prompt-action-row--mode-compact")).toBe(false);

    panelWidth = 420;
    contextClientWidth = 400;
    contextScrollWidth = 400;
    actionClientWidth = 400;
    actionFullScrollWidth = 400;
    actionModelCompactScrollWidth = 400;
    panelObserver.callback([{ target: panel, contentRect: { width: panelWidth } } as ResizeObserverEntry], panelObserver as unknown as ResizeObserver);
    await waitForSettled("composer compact state", () => !contextRow.classList.contains("ai-prompt-context-row--compact") && !actionRow.classList.contains("ai-prompt-action-row--model-compact") && !actionRow.classList.contains("ai-prompt-action-row--mode-compact"), compactState);
    expect(contextRow.classList.contains("ai-prompt-context-row--compact")).toBe(false);
    expect(actionRow.classList.contains("ai-prompt-action-row--model-compact")).toBe(false);
    expect(actionRow.classList.contains("ai-prompt-action-row--mode-compact")).toBe(false);

    endPanelResize();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(contextRow.classList.contains("ai-prompt-context-row--compact")).toBe(false);
    expect(actionRow.classList.contains("ai-prompt-action-row--model-compact")).toBe(false);
    expect(actionRow.classList.contains("ai-prompt-action-row--mode-compact")).toBe(false);
    expect(errors.map(String)).toEqual([]);
    // The turn budget above can take a while on a contended CI worker; keep the diagnostic
    // error reachable instead of tripping the default 10s test timeout first.
  }, 30_000);

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

  // #10058 R4/R5: the selection becomes a removable chip and the input box stays
  // empty for the user's own request — but an empty box plus a chip must still be
  // submittable, which is why every `contextItemCount` site had to learn about it.
  it("shows an editor selection as a submittable chip instead of prefilling the composer", async () => {
    const { errors, container, panelRef } = await mountPanel(true, { id: "postgres", name: "PostgreSQL", db_type: "postgres", host: "localhost", port: 5432, username: "", password: "", database: "app" }, (settings) => {
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
    });

    panelRef.value!.openExternalContext({
      target: { connectionId: "postgres", database: "app" },
      selections: [{ source: "editor", label: "query-1", content: "select * from orders" }],
      unresolvedKey: "ai.externalTargetUnavailable",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea.ai-conversation-text");
    expect(textarea?.value).toBe("");
    expect(container.querySelector("[data-ai-selection-chips]")?.textContent).toContain("query-1");
    const sendButton = Array.from(container.querySelectorAll<HTMLButtonElement>(".ai-prompt-send-control")).find((button) => !button.classList.contains("ai-prompt-queue-control"));
    expect(sendButton?.disabled).toBe(false);
    expect(errors.map(String)).toEqual([]);
  });

  it("leaves the composer unbound when the selection's connection is gone", async () => {
    const { container, panelRef } = await mountPanel(true, { id: "postgres", name: "PostgreSQL", db_type: "postgres", host: "localhost", port: 5432, username: "", password: "" });

    // The toast is a global singleton, so clear it: the assertion below must
    // only be satisfiable by this trigger.
    useToast().dismissToast();
    useToast().message.value = "";

    // The editor tab outlives its connection; the request must not inherit the
    // ambient one silently (R6), so the send stays disabled until the user picks.
    panelRef.value!.openExternalContext({
      target: null,
      selections: [{ source: "editor", label: "query-1", content: "select 1" }],
      unresolvedKey: "ai.externalTargetUnavailable",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(container.querySelector("[data-ai-selection-chips]")?.textContent).toContain("query-1");
    const sendButton = Array.from(container.querySelectorAll<HTMLButtonElement>(".ai-prompt-send-control")).find((button) => !button.classList.contains("ai-prompt-queue-control"));
    expect(sendButton?.disabled).toBe(true);
    // Degrading silently would leave the user typing into a box that cannot
    // send: the panel has to say why (R6). The toast host lives in App.vue, so
    // this asserts the message the panel publishes, localized.
    expect(useToast().visible.value).toBe(true);
    expect(useToast().message.value).toBe(i18n.global.t("ai.externalTargetUnavailable"));
  });

  // The three entries outside the panel (#10058 R1/R3) all land here, so these
  // drive the real component: the pure `resolveExternalSendTarget` cannot show
  // whether the chosen binding was applied *before* the request left, and a
  // selection chip that renders is worthless if the send drops it.
  const POSTGRES: ConnectionConfig = { id: "postgres", name: "PostgreSQL", db_type: "postgres", host: "localhost", port: 5432, username: "", password: "", database: "app" };
  const CONN_A: ConnectionConfig = { id: "conn-a", name: "ConnA", db_type: "mysql", host: "localhost", port: 3306, username: "", password: "", database: "db_a" };

  function configureAiPanel(settings: ReturnType<typeof useSettingsStore>) {
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
  }

  function storedConversation(overrides: Record<string, unknown> = {}) {
    return {
      id: "conv-a",
      title: "Chat A",
      connectionName: "ConnA",
      connectionId: "conn-a",
      database: "db_a",
      messages: [{ role: "user", content: "previous question" }],
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
      ...overrides,
    };
  }

  function sendControl(container: HTMLElement): HTMLButtonElement {
    return Array.from(container.querySelectorAll<HTMLButtonElement>(".ai-prompt-send-control")).find((button) => !button.classList.contains("ai-prompt-queue-control"))!;
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("reuses the chat already on the selection's namespace and attaches the chip there", async () => {
    aiAssistantMountApi.conversations = [storedConversation({ id: "conv-b", connectionId: "postgres", database: "app", connectionName: "PostgreSQL" })];
    const { errors, container, panelRef } = await mountPanel(true, POSTGRES, (settings) => {
      configureAiPanel(settings);
      settings.restoreLastConversation = true;
    });
    expect(container.textContent).toContain("previous question");

    panelRef.value!.openExternalContext({
      target: { connectionId: "postgres", database: "app" },
      selections: [{ source: "editor", label: "query-1", content: "select * from orders" }],
      unresolvedKey: "ai.externalTargetUnavailable",
    });
    await settle();

    // Same namespace → the chip lands in the chat that is already on screen.
    expect(container.querySelector("[data-ai-selection-chips]")?.textContent).toContain("query-1");
    expect(container.textContent).toContain("previous question");
    expect(aiAssistantMountApi.savedConversations).toEqual([]);
    expect(errors.map(String)).toEqual([]);
  });

  it("opens its own chat for another namespace without rewriting the stored conversation", async () => {
    const stored = storedConversation({ schema: "s1" });
    aiAssistantMountApi.conversations = [stored];
    const { errors, container, panelRef } = await mountPanel(
      true,
      CONN_A,
      (settings) => {
        configureAiPanel(settings);
        settings.restoreLastConversation = true;
      },
      undefined,
      [POSTGRES],
    );
    expect(container.textContent).toContain("previous question");

    panelRef.value!.openExternalContext({
      target: { connectionId: "postgres", database: "app" },
      selections: [{ source: "editor", label: "query-1", content: "select * from orders" }],
      unresolvedKey: "ai.externalTargetUnavailable",
    });
    await settle();

    // The #9902 contract: a trigger from another namespace opens its own chat…
    expect(container.textContent).not.toContain("previous question");
    expect(container.querySelector("[data-ai-selection-chips]")?.textContent).toContain("query-1");
    // …and never rewrites the existing record: same binding, same timestamp, and
    // nothing was written back (a `rebindConversation` regression would show up
    // here as a saved copy with connectionId "postgres").
    expect(stored.connectionId).toBe("conn-a");
    expect(stored.database).toBe("db_a");
    expect(stored.updatedAt).toBe("2026-09-27T00:00:00.000Z");
    expect(aiAssistantMountApi.savedConversations).toEqual([]);
    expect(errors.map(String)).toEqual([]);
  });

  it("carries the selection into the outgoing request and marks an over-budget one visibly", async () => {
    const { errors, container, panelRef } = await mountPanel(true, POSTGRES, configureAiPanel);
    const oversized = "x".repeat(AI_SELECTION_CONTEXT_MAX_CHARS + 25);

    panelRef.value!.openExternalContext({
      target: { connectionId: "postgres", database: "app" },
      selections: [{ source: "editor", label: "huge.sql", content: oversized }],
      unresolvedKey: "ai.externalTargetUnavailable",
    });
    await settle();

    const chip = container.querySelector("[data-ai-selection-chips]");
    expect(chip?.textContent).toContain("huge.sql");
    // Truncation has to be visible (R5), not just flagged internally.
    expect(chip?.textContent).toContain(i18n.global.t("ai.attachmentTruncatedStatus"));
    expect(chip?.querySelector("[title]")?.getAttribute("title")).toContain(i18n.global.t("ai.attachmentTruncatedStatus"));
    // The panel was blank: the target went into the draft in place, so no extra
    // empty conversation was written (R2).
    expect(aiAssistantMountApi.savedConversations).toEqual([]);
    expect(container.querySelector("[data-ai-composer-context-row]")?.textContent).toContain("PostgreSQL");

    // The box is empty: the user's own words are the request.
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea.ai-conversation-text")!;
    expect(textarea.value).toBe("");
    textarea.value = "explain this";
    textarea.dispatchEvent(new Event("input"));
    await settle();
    sendControl(container).click();
    await settle();

    const input = aiAssistantMountApi.runAgentStreamInputs.at(-1) as AiRequestInput;
    expect(input).toBeTruthy();
    const context = input.context as AiContext;
    expect(context.connectionId).toBe("postgres");
    expect(context.selections).toHaveLength(1);
    // The 12 000-char budget holds through the real send path, not just in the helper.
    expect(context.selections![0].content).toHaveLength(AI_SELECTION_CONTEXT_MAX_CHARS);
    expect(context.selections![0].content).toBe(oversized.slice(0, AI_SELECTION_CONTEXT_MAX_CHARS));
    expect(context.selections![0].truncated).toBe(true);
    // …and it reaches the model as data, while the instruction stays the user's.
    const request = buildAgentRequest(input);
    const userTurn = request.messages.at(-1)?.content ?? "";
    expect(userTurn).toContain("<attached-text-data>");
    expect(userTurn).toContain("Source: editor — huge.sql (truncated)");
    expect(request.taskContract.userRequest).toBe("explain this");
    // Composer context is consumed by the send, so the next turn cannot resend it.
    expect(container.querySelector("[data-ai-selection-chips]")).toBeNull();
    // Positive control for the persistence spy the routing tests rely on: a send
    // does write a conversation record, bound to the trigger's namespace.
    expect(aiAssistantMountApi.savedConversations.length).toBeGreaterThan(0);
    for (const saved of aiAssistantMountApi.savedConversations) {
      expect(saved.connectionId).toBe("postgres");
      expect(saved.database).toBe("app");
    }
    expect(errors.map(String)).toEqual([]);
  });

  it("stops stacking selection chips at the aggregate budget", async () => {
    const { errors, container, panelRef } = await mountPanel(true, POSTGRES, configureAiPanel);

    panelRef.value!.openExternalContext({
      target: { connectionId: "postgres", database: "app" },
      selections: Array.from({ length: 9 }, (_, i) => ({ source: "editor" as const, label: `sel-${i + 1}`, content: "select 1" })),
      unresolvedKey: "ai.externalTargetUnavailable",
    });
    await settle();

    const chips = container.querySelector("[data-ai-selection-chips]");
    expect(chips?.textContent).toContain("sel-8");
    // The 9th gesture is rejected by the count budget instead of stacking
    // another chip into the same request.
    expect(chips?.textContent).not.toContain("sel-9");
    expect(errors.map(String)).toEqual([]);
  });

  it("runs 'Fix with AI' against the editor tab's namespace, not the ambient connection", async () => {
    // The panel sits on ConnA while the failing query came from the postgres tab.
    const { errors, panelRef } = await mountPanel(true, CONN_A, configureAiPanel, undefined, [POSTGRES]);

    panelRef.value!.openExternalContext({
      target: { connectionId: "postgres", database: "app" },
      action: "fix",
      instruction: 'syntax error at or near "form"',
      unresolvedKey: "ai.externalTargetUnavailable",
    });
    await settle();

    const input = aiAssistantMountApi.runAgentStreamInputs.at(-1) as AiRequestInput;
    expect(input?.action).toBe("fix");
    expect(input?.instruction).toContain("syntax error");
    // The binding is applied synchronously before `triggerAction` → `send()`, so
    // the request cannot leave with the ambient target (R1/R2).
    expect((input.context as AiContext).connectionId).toBe("postgres");
    expect(errors.map(String)).toEqual([]);
  });

  it("opens a new chat bound to the tree node's namespace and keeps its table mention", async () => {
    aiAssistantMountApi.conversations = [storedConversation()];
    const { errors, container, panelRef } = await mountPanel(
      true,
      CONN_A,
      (settings) => {
        configureAiPanel(settings);
        settings.restoreLastConversation = true;
      },
      undefined,
      [POSTGRES],
    );
    expect(container.textContent).toContain("previous question");

    // What App.vue's `addToAi` now hands over: a target plus the node's tables.
    panelRef.value!.openExternalContext({ target: { connectionId: "postgres", database: "app" }, tableMentions: [{ schema: "public", table: "orders" }] });
    await settle();

    expect(container.textContent).not.toContain("previous question");
    // The composer renders the mention label without the `@` sigil.
    expect(container.textContent).toContain("public.orders");
    expect(aiAssistantMountApi.savedConversations).toEqual([]);
    expect(errors.map(String)).toEqual([]);
  });

  it("persists a selection footprint, not its label or content", async () => {
    const { errors, container, panelRef } = await mountPanel(true, POSTGRES, configureAiPanel);

    panelRef.value!.openExternalContext({
      target: { connectionId: "postgres", database: "app" },
      selections: [{ source: "editor", label: "query-1", content: "select * from orders" }],
      unresolvedKey: "ai.externalTargetUnavailable",
    });
    await settle();
    expect(container.querySelector<HTMLTextAreaElement>("textarea.ai-conversation-text")?.value).toBe("");
    sendControl(container).click();
    await settle();

    const stored = aiAssistantMountApi.savedConversations.at(-1) as {
      title?: string;
      messages: Array<{ role: string; content: string; mentions?: unknown[]; selectionsOmitted?: boolean }>;
    };
    const storedUserTurn = stored.messages.find((message) => message.role === "user")!;
    // Only the boolean: the record is cloud-synced, so neither the (up to
    // 12 000-char) text nor a per-message label may be written to it.
    expect(storedUserTurn.selectionsOmitted).toBe(true);
    expect(storedUserTurn.content).toBe("");
    expect(storedUserTurn.mentions).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain("select * from orders");
    // The conversation *title* still names the turn from the chip label, exactly
    // as it does for a table mention — that is a name for the chat, not a claim
    // that the content is still around.
    expect(stored.title).toBe("query-1");
    expect(errors.map(String)).toEqual([]);
  });

  // #10058 follow-up continuity: the selection used to live in `message.content`
  // (the composer prefill), so it survived a reload by accident. In the context
  // channel its text is session-only, so the model must be told instead of
  // receiving an empty user turn. Both directions are asserted here, because the
  // note firing unconditionally would also pass a restart-only test.
  it("tells the model a prior selection is gone after a restart, but not while it is still live", async () => {
    const first = await mountPanel(true, POSTGRES, configureAiPanel);

    first.panelRef.value!.openExternalContext({
      target: { connectionId: "postgres", database: "app" },
      selections: [{ source: "editor", label: "query-1", content: "select * from orders" }],
      unresolvedKey: "ai.externalTargetUnavailable",
    });
    await settle();
    const firstTextarea = first.container.querySelector<HTMLTextAreaElement>("textarea.ai-conversation-text")!;
    firstTextarea.value = "explain this";
    firstTextarea.dispatchEvent(new Event("input"));
    await settle();
    sendControl(first.container).click();
    await settle();

    // Same session, second turn: the selection is still live on the message, so
    // it replays into the data block and no omission note may appear.
    const secondTextarea = first.container.querySelector<HTMLTextAreaElement>("textarea.ai-conversation-text")!;
    secondTextarea.value = "and again";
    secondTextarea.dispatchEvent(new Event("input"));
    await settle();
    sendControl(first.container).click();
    await settle();

    const liveHistory = (aiAssistantMountApi.runAgentStreamHistories.at(-1) as Array<{ content: string }>)!;
    const liveTurn = liveHistory.find((message) => message.content.includes("select * from orders"))!;
    expect(liveTurn).toBeTruthy();
    expect(liveTurn.content).toContain("Source: editor — query-1");
    expect(liveTurn.content).not.toContain("Prior-turn selection content");

    // Restart: mount a fresh panel over the record that was written.
    const stored = aiAssistantMountApi.savedConversations.at(-1)!;
    cleanups.shift()?.();
    aiAssistantMountApi.conversations = [stored];
    aiAssistantMountApi.runAgentStreamInputs = [];
    aiAssistantMountApi.runAgentStreamHistories = [];
    const second = await mountPanel(true, POSTGRES, (settings) => {
      configureAiPanel(settings);
      settings.restoreLastConversation = true;
    });
    // The turn must still be on screen: with the selection text gone and no
    // mention or content to render, the bubble's own `v-if` would otherwise drop
    // the whole turn the user sent.
    expect(second.container.textContent).toContain(i18n.global.t("ai.selectionChipLabel"));
    expect(second.container.textContent).toContain(i18n.global.t("ai.attachmentUnavailableAfterReload"));
    const reloadedTextarea = second.container.querySelector<HTMLTextAreaElement>("textarea.ai-conversation-text")!;
    reloadedTextarea.value = "now what about the columns?";
    reloadedTextarea.dispatchEvent(new Event("input"));
    await settle();
    sendControl(second.container).click();
    await settle();

    const reloadedHistory = (aiAssistantMountApi.runAgentStreamHistories.at(-1) as Array<{ content: string }>)!;
    const replayedTurn = reloadedHistory.find((message) => message.content.includes("Prior-turn selection content"))!;
    expect(replayedTurn).toBeTruthy();
    // The text itself is gone (never persisted), so it is not replayed.
    expect(replayedTurn.content).not.toContain("select * from orders");
    // Sending after the first reload snapshots the old user turn again. Its
    // footprint must survive that second persistence cycle as well.
    const resaved = aiAssistantMountApi.savedConversations.at(-1) as { messages: Array<{ role: string; selectionsOmitted?: boolean }> };
    expect(resaved.messages.find((message) => message.role === "user")?.selectionsOmitted).toBe(true);
    expect(second.errors.map(String)).toEqual([]);
  });
});
