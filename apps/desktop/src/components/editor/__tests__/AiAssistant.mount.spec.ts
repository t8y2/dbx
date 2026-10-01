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
  // Fifth argument: the custom prompt context (globals, templates, skill listing).
  runAgentStreamCustoms: [] as unknown[],
  savedConversations: [] as Array<Record<string, unknown>>,
  codeHighlighterDelayMs: 0,
  // Skill catalog + body a test wants the backend to answer with.
  skillCatalog: {
    defaultRoot: { status: "ok", skills: [] as Array<{ id: string; name: string; description: string }> },
    customRoot: null as { status: string; skills: Array<{ id: string; name: string; description: string }> } | null,
  },
  skillReadResult: undefined as undefined | { skills: Array<{ id: string; name: string; description: string; content: string }>; failures: Array<{ id: string; reason: string }> },
  skillReadCalls: [] as string[][],
  // How many times the panel asked for the catalog. The banner's Refresh and a
  // retried send both re-read it, so a count is what tells the two apart.
  skillListCalls: 0,
  // `supportsCliProviders` is a runtime capability, so a CLI model config is only a
  // valid active config under Tauri. The panel mounts on the web/http lane here
  // (false), where a CLI config is ineligible and its disabled selector never
  // renders — the skill-capability test flips this for its own duration.
  tauriRuntime: false,
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
      aiAssistantMountApi.runAgentStreamCustoms.push(args[4]);
      const onEvent = args[2] as (event: { type: string; delta?: string }) => void;
      return aiAssistantMountApi.runAgentStream?.(onEvent) ?? "";
    },
  };
});

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => aiAssistantMountApi.tauriRuntime }));

// Reka's popover does not survive this harness: once a `PopoverContent` sibling
// exists, the trigger's merged click handler is dropped on its re-render, so a
// click can never open one (verified against a bare reka root in isolation).
// The panel's own logic is what these tests are about — the skill selector's open
// state, the listed rows, the chips — so the popover is stubbed to the same
// observable contract: trigger toggles, content renders only while open, and the
// closed state still emits no `[data-slot="popover-content"]`.
vi.mock("@/components/ui/popover", async () => {
  const { cloneVNode, defineComponent, h, inject, provide, ref, watch } = await import("vue");
  const contextKey = Symbol("popover-stub");
  const passthrough = (name: string) =>
    defineComponent({
      name,
      setup(_, { slots }) {
        return () => h("div", slots.default?.());
      },
    });
  const Popover = defineComponent({
    name: "PopoverStub",
    props: { open: { type: Boolean, default: false } },
    emits: ["update:open"],
    setup(props, { emit, slots }) {
      const open = ref(props.open);
      watch(
        () => props.open,
        (value) => {
          open.value = value;
        },
      );
      provide(contextKey, {
        open,
        toggle: () => {
          open.value = !open.value;
          emit("update:open", open.value);
        },
      });
      return () => h("div", { "data-slot": "popover" }, slots.default?.());
    },
  });
  const PopoverTrigger = defineComponent({
    name: "PopoverTriggerStub",
    setup(_, { slots }) {
      const context = inject<{ open: { value: boolean }; toggle: () => void } | undefined>(contextKey);
      // `as-child` semantics for a plain element trigger (the attributes land on
      // the caller's own button, which is what the panel's tests read); a trigger
      // built from a component keeps its own element and gets a wrapper instead.
      return () => {
        const attributes = {
          "data-slot": "popover-trigger",
          "aria-expanded": String(context?.open.value ?? false),
          onClick: () => context?.toggle(),
        };
        const children = slots.default?.() ?? [];
        const child = Array.isArray(children) ? children[0] : children;
        return child && typeof child.type === "string" ? cloneVNode(child, attributes) : h("span", attributes, children);
      };
    },
  });
  const PopoverContent = defineComponent({
    name: "PopoverContentStub",
    setup(_, { slots }) {
      const context = inject<{ open: { value: boolean } } | undefined>(contextKey);
      // `role="dialog"` mirrors reka's own content role, which the panel's tests read.
      return () => (context?.open.value ? h("div", { "data-slot": "popover-content", role: "dialog" }, slots.default?.()) : null);
    },
  });
  return { Popover, PopoverTrigger, PopoverContent, PopoverAnchor: passthrough("PopoverAnchorStub") };
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
    // The send path consults the skill catalog (metadata only — bodies are read
    // on demand by the use_skill tool); an empty catalog keeps sends skill-free.
    listUserSkills: () => {
      aiAssistantMountApi.skillListCalls += 1;
      return Promise.resolve(aiAssistantMountApi.skillCatalog);
    },
    readUserSkills: (ids: string[]) => {
      aiAssistantMountApi.skillReadCalls.push(ids);
      const result = aiAssistantMountApi.skillReadResult;
      return result ? Promise.resolve(result) : Promise.reject(new Error("readUserSkills not configured"));
    },
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
  aiAssistantMountApi.runAgentStreamCustoms = [];
  aiAssistantMountApi.savedConversations = [];
  aiAssistantMountApi.codeHighlighterDelayMs = 0;
  aiAssistantMountApi.skillCatalog = { defaultRoot: { status: "ok", skills: [] }, customRoot: null };
  aiAssistantMountApi.skillReadResult = undefined;
  aiAssistantMountApi.skillReadCalls = [];
  aiAssistantMountApi.skillListCalls = 0;
  aiAssistantMountApi.tauriRuntime = false;
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

  // Skill capability belongs to DBX's built-in AI only (prd 09-30 Req 15a). A CLI
  // user can still hold a selection, so the narrowed capability has to be stated:
  // a disabled control with no reason would read as a bug rather than a boundary.
  it("disables the skill selector with a reason under a CLI provider", async () => {
    const { errors, container } = await mountPanel(true, undefined, (settings) => {
      // A CLI config is only an eligible model when the runtime supports CLI
      // providers, so this test runs the panel on the Tauri lane.
      aiAssistantMountApi.tauriRuntime = true;
      settings.aiConfigs = [
        {
          id: "cli-default",
          name: "Claude Code",
          provider: "claude-code-cli",
          apiKey: "",
          authMethod: "api-key",
          endpoint: "",
          model: "",
          apiStyle: "completions",
          isDefault: true,
        },
      ];
      settings.activeModel = { configId: "cli-default", modelId: "" };
    });

    const trigger = container.querySelector<HTMLButtonElement>(".ai-skills-selector-trigger");
    expect(trigger).not.toBeNull();
    expect(trigger!.disabled).toBe(true);
    expect(trigger!.getAttribute("aria-label")).toBe(i18n.global.t("ai.skillsUnsupportedForCliProvider"));
    expect(trigger!.getAttribute("title")).toBe(i18n.global.t("ai.skillsUnsupportedForCliProvider"));
    // A disabled button is not what keeps the popover shut — clicking must not open
    // it either, or the user reaches the silent selection state this replaces.
    trigger!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.querySelector('[data-slot="popover-content"]')).toBeNull();
    expect(errors.map(String)).toEqual([]);
  });

  it("keeps the skill selector enabled and labelled for a built-in provider", async () => {
    const { errors, container } = await mountPanel(true, undefined, (settings) => {
      aiAssistantMountApi.tauriRuntime = true;
      settings.aiConfigs = [
        {
          id: "builtin-default",
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
      settings.activeModel = { configId: "builtin-default", modelId: "deepseek-chat" };
    });

    const trigger = container.querySelector<HTMLButtonElement>(".ai-skills-selector-trigger");
    expect(trigger).not.toBeNull();
    expect(trigger!.disabled).toBe(false);
    expect(trigger!.getAttribute("aria-label")).toBe(i18n.global.t("ai.skillsEntry"));
    expect(trigger!.getAttribute("title")).toBe(i18n.global.t("ai.skillsEntry"));
    expect(errors.map(String)).toEqual([]);
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

  // --- Skills (prd 09-30): the listing gate, the two chip states, the forced load ---

  const SKILL = { id: "d-review", name: "sql-review", description: "review rules" };
  const SKILL_BODY = "---\nname: sql-review\ndescription: review rules\n---\n\nAlways check the WHERE clause.";

  function configureSkillCatalog(): void {
    aiAssistantMountApi.skillCatalog = { defaultRoot: { status: "ok", skills: [SKILL] }, customRoot: null };
  }

  function configureSkillRead(failures: Array<{ id: string; reason: string }> = []): void {
    aiAssistantMountApi.skillReadResult = failures.length ? { skills: [], failures } : { skills: [{ ...SKILL, content: SKILL_BODY }], failures: [] };
  }

  /** Drives the real selector: open the popover and tick the one listed skill. */
  async function selectSkill(container: HTMLElement): Promise<void> {
    const trigger = container.querySelector<HTMLElement>(".ai-skills-selector-trigger")!;
    // The selector can already be open (selecting a row does not close it).
    let popover = container.querySelector<HTMLElement>('[data-slot="popover-content"]');
    if (!popover) {
      trigger.click();
      await settle();
      popover = container.querySelector<HTMLElement>('[data-slot="popover-content"]');
    }
    expect(popover).not.toBeNull();
    const row = Array.from(popover!.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes(SKILL.name));
    expect(row).toBeTruthy();
    row!.click();
    await settle();
  }

  function skillChip(container: HTMLElement): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(".ai-skill-chip");
  }

  function skillHint(container: HTMLElement): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(".ai-skill-hint");
  }

  /** The send-blocked banner is the panel's only `role="alert"` region. */
  function skillBanner(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>('[role="alert"]');
  }

  /** A recovery action inside that banner, addressed by its rendered label. */
  function skillBannerButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="alert"] button')).find((button) => button.textContent?.trim() === label);
  }

  async function sendPrompt(container: HTMLElement, text: string): Promise<void> {
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea.ai-conversation-text")!;
    textarea.value = text;
    textarea.dispatchEvent(new Event("input"));
    await settle();
    sendControl(container).click();
    await settle();
  }

  function lastHistory(): Array<{ role: string; content: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; toolCallId?: string }> {
    return aiAssistantMountApi.runAgentStreamHistories.at(-1) as Array<{
      role: string;
      content: string;
      toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
      toolCallId?: string;
    }>;
  }

  // Req 5: the toggle alone opens the gate — no selection needed — and the tool
  // flag follows the listing rather than being a second decision (ADR Decision 10).
  it("injects the skill listing from the Settings toggle with nothing selected", async () => {
    configureSkillCatalog();
    const { errors, container } = await mountPanel(true, POSTGRES, (settings) => {
      configureAiPanel(settings);
      settings.desktopSettings = { ...settings.desktopSettings, custom_ai_skill_auto_enabled: true };
    });
    expect(skillChip(container)).toBeNull();

    await sendPrompt(container, "which tables are stale?");

    const custom = aiAssistantMountApi.runAgentStreamCustoms.at(-1) as { skillListing?: string[] } | undefined;
    // The entry line is language-neutral, so the assertion does not depend on the
    // active locale; the unselected entry carries no [user-selected] marker.
    expect(custom?.skillListing?.join("\n")).toContain(`- ${SKILL.name} [default]: review rules`);
    expect((aiAssistantMountApi.runAgentStreamInputs.at(-1) as { allowSkills?: boolean }).allowSkills).toBe(true);
    // Assembled by the real prompt builder: the listing really reaches the
    // system prompt, not just the request object.
    const request = buildAgentRequest(aiAssistantMountApi.runAgentStreamInputs.at(-1) as AiRequestInput, [], custom);
    expect(request.systemPrompt).toContain(`- ${SKILL.name} [default]: review rules`);
    expect(errors.map(String)).toEqual([]);
  });

  it("lights the chip from a use_skill tool event and keeps it after reopening the panel", async () => {
    configureSkillCatalog();
    aiAssistantMountApi.runAgentStream = async (onEvent) => {
      onEvent({ type: "tool_call_start", tool_call_id: "call-1", tool_name: "use_skill", args: { skill: SKILL.name, source: "default" } });
      return "reviewed";
    };
    const first = await mountPanel(true, POSTGRES, configureAiPanel);
    await selectSkill(first.container);
    expect(skillChip(first.container)!.textContent).not.toContain(i18n.global.t("ai.skillsLoadedState"));

    await sendPrompt(first.container, "review this query");
    expect(skillChip(first.container)!.textContent).toContain(i18n.global.t("ai.skillsLoadedState"));

    // Panel closed and reopened over the same conversation. The selection itself
    // is panel-session state, so the user re-picks the skill — and the loaded
    // state must already be on the chip instead of resetting with the panel.
    const stored = aiAssistantMountApi.savedConversations.at(-1)!;
    cleanups.shift()?.();
    aiAssistantMountApi.conversations = [stored];
    aiAssistantMountApi.runAgentStreamInputs = [];
    aiAssistantMountApi.runAgentStreamHistories = [];
    aiAssistantMountApi.runAgentStreamCustoms = [];
    const second = await mountPanel(true, POSTGRES, (settings) => {
      configureAiPanel(settings);
      settings.restoreLastConversation = true;
    });
    expect(second.container.textContent).toContain("review this query");
    await selectSkill(second.container);
    expect(skillChip(second.container)!.textContent).toContain(i18n.global.t("ai.skillsLoadedState"));
    expect(second.errors.map(String)).toEqual([]);
  });

  it("shows the one-time hint until a selected skill is loaded, and clicking it loads", async () => {
    configureSkillCatalog();
    configureSkillRead();
    const { errors, container } = await mountPanel(true, POSTGRES, configureAiPanel);

    await selectSkill(container);
    expect(skillHint(container)).not.toBeNull();
    expect(skillHint(container)!.textContent?.trim()).toBe(i18n.global.t("ai.skillsPreloadHint", { name: SKILL.name }));

    // A further turn does not spawn a second hint: it is latched, not per-turn.
    await sendPrompt(container, "anything else");
    expect(container.querySelectorAll(".ai-skill-hint").length).toBe(1);

    // Clicking it is the same force-load as the chip, and loading is what makes
    // it fall away.
    skillHint(container)!.click();
    await settle();
    expect(skillHint(container)).toBeNull();
    expect(skillChip(container)!.textContent).toContain(i18n.global.t("ai.skillsLoadedState"));
    expect(errors.map(String)).toEqual([]);
  });

  it("does not re-show the hint once it has been shown in this conversation", async () => {
    configureSkillCatalog();
    const { errors, container } = await mountPanel(true, POSTGRES, configureAiPanel);

    await selectSkill(container);
    expect(skillHint(container)).not.toBeNull();

    container.querySelector<HTMLButtonElement>(".ai-skill-chip-remove")!.click();
    await settle();
    expect(skillHint(container)).toBeNull();

    await selectSkill(container);
    expect(skillChip(container)).not.toBeNull();
    expect(skillHint(container)).toBeNull();
    expect(errors.map(String)).toEqual([]);
  });

  // Req 13's core promise: the body reaches the model, and nothing but the fact
  // reaches the record. A conversation record is the record a chat sync or backup
  // would ship, so a body (up to 1 MiB per skill) must never be written into it —
  // the same rule the #10058 selection footprint follows.
  it("replays a forced skill load without writing its body into the record", async () => {
    configureSkillCatalog();
    configureSkillRead();
    const { errors, container } = await mountPanel(true, POSTGRES, configureAiPanel);
    await selectSkill(container);

    skillChip(container)!.click();
    await settle();
    expect(aiAssistantMountApi.skillReadCalls.at(-1)).toEqual([SKILL.id]);
    expect(skillChip(container)!.textContent).toContain(i18n.global.t("ai.skillsLoadedState"));

    await sendPrompt(container, "review this query");

    const history = lastHistory();
    const call = history.find((message) => message.toolCalls?.length);
    const result = history.find((message) => message.role === "tool");
    expect(call?.toolCalls?.[0]).toMatchObject({ name: "use_skill", arguments: { skill: SKILL.name, source: "default" } });
    // The pair is a real round: the result answers the call it was paired with.
    expect(result?.toolCallId).toBe(call?.toolCalls?.[0].id);
    expect(result?.content).toContain("Always check the WHERE clause.");
    // The listing (and with it the tool table) is there for that request.
    expect((aiAssistantMountApi.runAgentStreamInputs.at(-1) as { allowSkills?: boolean }).allowSkills).toBe(true);

    const saved = aiAssistantMountApi.savedConversations.at(-1)! as unknown as {
      messages: Array<{ role: string; content: string; loadedSkillIds?: string[] }>;
    };
    // The fact, on the newest assistant turn — and no body anywhere in the record.
    expect(saved.messages.filter((message) => message.loadedSkillIds?.length).map((message) => message.loadedSkillIds)).toEqual([[SKILL.id]]);
    expect(saved.messages.some((message) => message.role === "tool")).toBe(false);
    expect(JSON.stringify(saved)).not.toContain("Always check the WHERE clause.");
    expect(errors.map(String)).toEqual([]);

    // Restart over that record: the body is gone from memory (a hand-built record
    // stands in for one written by a previous app run, so this process never held
    // the body), the chip is lit from the fact alone, and the body comes back from
    // disk for the request that needs it.
    cleanups.shift()?.();
    aiAssistantMountApi.conversations = [
      storedConversation({
        id: "conv-skill-restored",
        connectionId: "postgres",
        database: "app",
        connectionName: "PostgreSQL",
        messages: [
          { role: "user", content: "review this query" },
          { role: "assistant", content: "reviewed", loadedSkillIds: [SKILL.id] },
        ],
      }),
    ];
    aiAssistantMountApi.runAgentStreamInputs = [];
    aiAssistantMountApi.runAgentStreamHistories = [];
    aiAssistantMountApi.runAgentStreamCustoms = [];
    aiAssistantMountApi.skillReadCalls = [];
    const second = await mountPanel(true, POSTGRES, (settings) => {
      configureAiPanel(settings);
      settings.restoreLastConversation = true;
    });
    await selectSkill(second.container);
    expect(skillChip(second.container)!.textContent).toContain(i18n.global.t("ai.skillsLoadedState"));
    expect(aiAssistantMountApi.skillReadCalls).toEqual([]);

    await sendPrompt(second.container, "and the indexes?");
    expect(aiAssistantMountApi.skillReadCalls).toEqual([[SKILL.id]]);
    const replayed = lastHistory().find((message) => message.role === "tool");
    expect(replayed?.content).toContain("Always check the WHERE clause.");
    expect(second.errors.map(String)).toEqual([]);
  });

  // The body is session-only, so a conversation can outlive it (the skill was
  // deleted, or grew past the read limit). The fact must then stop claiming the
  // skill is loaded instead of leaving a lit chip over a body nobody has.
  it("clears the fact when a recorded skill can no longer be read", async () => {
    configureSkillCatalog();
    configureSkillRead([{ id: SKILL.id, reason: "oversized" }]);
    useToast().dismissToast();
    useToast().message.value = "";
    aiAssistantMountApi.conversations = [
      storedConversation({
        id: "conv-skill-gone",
        connectionId: "postgres",
        database: "app",
        connectionName: "PostgreSQL",
        messages: [
          { role: "user", content: "review this query" },
          { role: "assistant", content: "reviewed", loadedSkillIds: [SKILL.id] },
        ],
      }),
    ];
    const { errors, container } = await mountPanel(true, POSTGRES, (settings) => {
      configureAiPanel(settings);
      settings.restoreLastConversation = true;
    });
    await selectSkill(container);
    expect(skillChip(container)!.textContent).toContain(i18n.global.t("ai.skillsLoadedState"));

    await sendPrompt(container, "and the indexes?");

    // The restore was attempted for the recorded id — the body is not in this
    // process, and a distinct conversation id keeps a sibling test's session body
    // from satisfying it.
    expect(aiAssistantMountApi.skillReadCalls.at(-1)).toEqual([SKILL.id]);
    expect(useToast().message.value).toContain(i18n.global.t("ai.skillsReasonOversized"));
    expect(skillChip(container)!.textContent).not.toContain(i18n.global.t("ai.skillsLoadedState"));
    // The request still went out — without the body it could not restore.
    expect(lastHistory().some((message) => message.role === "tool")).toBe(false);
    // And the record stops asserting it: the next snapshot no longer carries it.
    const resaved = aiAssistantMountApi.savedConversations.at(-1) as { messages: Array<{ loadedSkillIds?: string[] }> };
    expect(resaved.messages.some((message) => message.loadedSkillIds?.length)).toBe(false);
    expect(errors.map(String)).toEqual([]);
  });

  // The refusal is the guard: a body that hit the read limit would be injected as
  // a tool result and wreck the context, so it is reported instead — and nothing
  // enters the history.
  it("reports a refused skill read instead of injecting a body", async () => {
    configureSkillCatalog();
    configureSkillRead([{ id: SKILL.id, reason: "oversized" }]);
    useToast().dismissToast();
    useToast().message.value = "";
    const { errors, container } = await mountPanel(true, POSTGRES, configureAiPanel);
    await selectSkill(container);

    skillChip(container)!.click();
    await settle();

    expect(aiAssistantMountApi.skillReadCalls.at(-1)).toEqual([SKILL.id]);
    expect(useToast().visible.value).toBe(true);
    expect(useToast().message.value).toContain(i18n.global.t("ai.skillsReasonOversized"));
    expect(skillChip(container)!.textContent).not.toContain(i18n.global.t("ai.skillsLoadedState"));

    await sendPrompt(container, "review this query");
    expect(lastHistory().some((message) => message.role === "tool")).toBe(false);
    expect(errors.map(String)).toEqual([]);
  });

  // The send-blocked banner (Req 15 / ADR Decision 8). Bodies load on demand, so
  // a deleted or unreadable file no longer stops a request — but a skill the user
  // ticked that is no longer in the catalog still does, and the failure has to
  // name which skill and offer the way out rather than failing silently.
  it("blocks the send and names a selected skill the catalog no longer lists", async () => {
    configureSkillCatalog();
    const { errors, container } = await mountPanel(true, POSTGRES, configureAiPanel);
    await selectSkill(container);
    expect(skillChip(container)).not.toBeNull();

    // The skill disappears between selection and send. The send path re-reads the
    // catalog (metadata only, never a body) and refuses before assembling any
    // request.
    aiAssistantMountApi.skillCatalog = { defaultRoot: { status: "ok", skills: [] }, customRoot: null };
    await sendPrompt(container, "review this query");

    expect(aiAssistantMountApi.runAgentStreamInputs).toEqual([]);
    const banner = skillBanner(container)!;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain(i18n.global.t("ai.skillsSendBlocked"));
    expect(banner.textContent).toContain(SKILL.name);
    // An `ok` root that simply lacks the id is `not_found`. The two reasons carry
    // different copy, and only `root_unavailable` offers Open Settings.
    expect(banner.textContent).toContain(i18n.global.t("ai.skillsReasonNotFound"));
    expect(banner.textContent).not.toContain(i18n.global.t("ai.skillsReasonRootUnavailable"));
    expect(skillBannerButton(container, i18n.global.t("ai.skillsRetry"))).not.toBeUndefined();
    expect(skillBannerButton(container, i18n.global.t("ai.skillsRefresh"))).not.toBeUndefined();
    expect(skillBannerButton(container, i18n.global.t("ai.skillsOpenSettings"))).toBeUndefined();

    // Remove is the documented recovery for this case: it drops the failed id so
    // the stale selection cannot block every later send.
    const remove = Array.from(banner.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.getAttribute("aria-label") === i18n.global.t("common.remove"))!;
    expect(remove).toBeTruthy();
    remove.click();
    await settle();
    expect(skillBanner(container)).toBeNull();
    expect(skillChip(container)).toBeNull();
    expect(errors.map(String)).toEqual([]);
  });

  it("re-sends from the banner once the skill is back, and Refresh only re-reads the catalog", async () => {
    configureSkillCatalog();
    const { errors, container } = await mountPanel(true, POSTGRES, configureAiPanel);
    await selectSkill(container);
    aiAssistantMountApi.skillCatalog = { defaultRoot: { status: "ok", skills: [] }, customRoot: null };
    await sendPrompt(container, "review this query");
    expect(skillBanner(container)).not.toBeNull();

    // Refresh re-reads the catalog without sending: the failure describes what
    // the request would carry, so it stands until the request is retried.
    const before = aiAssistantMountApi.skillListCalls;
    skillBannerButton(container, i18n.global.t("ai.skillsRefresh"))!.click();
    await settle();
    expect(aiAssistantMountApi.skillListCalls).toBeGreaterThan(before);
    expect(aiAssistantMountApi.runAgentStreamInputs).toEqual([]);
    expect(skillBanner(container)).not.toBeNull();

    // Retry is a real send of the same draft. With the skill back in the
    // catalog it goes through, and the listing (with the tools) rides along.
    aiAssistantMountApi.skillCatalog = { defaultRoot: { status: "ok", skills: [SKILL] }, customRoot: null };
    skillBannerButton(container, i18n.global.t("ai.skillsRetry"))!.click();
    await settle();
    expect(aiAssistantMountApi.runAgentStreamInputs.length).toBe(1);
    expect((aiAssistantMountApi.runAgentStreamInputs[0] as { allowSkills?: boolean }).allowSkills).toBe(true);
    expect(errors.map(String)).toEqual([]);
  });

  it("reports an unavailable root and offers Open Settings only for it", async () => {
    configureSkillCatalog();
    const { errors, container } = await mountPanel(true, POSTGRES, configureAiPanel);
    await selectSkill(container);

    // The whole default root is gone (removed, disabled, or unreadable) rather
    // than just this skill. That is the one reason with a settings-shaped fix, so
    // it is the one that renders the Open Settings action.
    aiAssistantMountApi.skillCatalog = { defaultRoot: { status: "missing", skills: [] }, customRoot: null };
    await sendPrompt(container, "review this query");

    expect(aiAssistantMountApi.runAgentStreamInputs).toEqual([]);
    const banner = skillBanner(container)!;
    expect(banner.textContent).toContain(i18n.global.t("ai.skillsReasonRootUnavailable"));
    expect(banner.textContent).not.toContain(i18n.global.t("ai.skillsReasonNotFound"));
    expect(skillBannerButton(container, i18n.global.t("ai.skillsOpenSettings"))).not.toBeUndefined();
    expect(errors.map(String)).toEqual([]);
  });

  // Req 12 / 15a: a selection made under an API provider must not leak into a CLI
  // run after the user switches models — the CLI run has no skill tools at all.
  it("sends no skill content to a CLI provider even with a skill selected", async () => {
    configureSkillCatalog();
    aiAssistantMountApi.tauriRuntime = true;
    let panelSettings: ReturnType<typeof useSettingsStore> | undefined;
    const { errors, container } = await mountPanel(true, POSTGRES, (settings) => {
      panelSettings = settings;
      settings.aiConfigs = [
        {
          id: "api",
          name: "Custom",
          provider: "openai-compatible",
          apiKey: "test-key",
          authMethod: "api-key",
          endpoint: "https://example.com/v1",
          model: "test-model",
          apiStyle: "completions",
          isDefault: true,
        },
        {
          id: "cli",
          name: "Claude Code",
          provider: "claude-code-cli",
          apiKey: "",
          authMethod: "api-key",
          endpoint: "",
          model: "",
          apiStyle: "completions",
        },
      ];
      settings.activeModel = { configId: "api", modelId: "test-model" };
    });
    await selectSkill(container);
    expect(skillChip(container)).not.toBeNull();

    // Req 15a: the selection stays visible after the model switch.
    panelSettings!.activeModel = { configId: "cli", modelId: "" };
    await settle();
    expect(skillChip(container)).not.toBeNull();

    await sendPrompt(container, "review this query");

    const custom = aiAssistantMountApi.runAgentStreamCustoms.at(-1) as { skillListing?: string[] } | undefined;
    expect(custom?.skillListing).toBeUndefined();
    expect((aiAssistantMountApi.runAgentStreamInputs.at(-1) as { allowSkills?: boolean }).allowSkills).toBe(false);
    expect(errors.map(String)).toEqual([]);
  });
});
