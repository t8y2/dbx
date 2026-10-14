// @vitest-environment happy-dom
//
// Regression spec for the `/skill` palette entry (picking `/skill` in the
// composer palette did nothing, while the identical Skills button worked).
//
// This file mounts the REAL reka-ui popover on purpose: the bug lived in reka's
// DismissableLayer, which dismisses the layer when a `focusin` lands outside it.
// `AiAssistant.mount.spec.ts` stubs the popover (its own note explains why), so
// it cannot observe a dismissal — hence a second spec with the real components.
//
// Two harness facts this spec has to arrange, or the bug is invisible:
//  1. happy-dom's `focus()` is not browser-faithful — it moves focus to a plain
//     `<div>`, which a browser refuses. Reka's FocusScope focuses its container
//     (a popper wrapper div) when the popover holds no tabbable element yet, so
//     without the shim below the popover is dismissed by a focus event no
//     browser would fire. The shim refuses focus on elements a browser refuses
//     and lets the rest (buttons, `tabindex` containers, the textarea) through.
//  2. The catalog must already be loaded, so the popover mounts with its skill
//     rows (tabbable buttons) and FocusScope's autofocus lands *inside* the
//     layer. That is the user's real situation — the selector had been opened
//     before — and it is the only state in which the textarea focus that used to
//     follow can steal focus out of a freshly-opened popover.
import { createApp, h } from "vue";
import type { Pinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import AiAssistant from "@/components/editor/AiAssistant.vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useUserSkillStore } from "@/stores/userSkillStore";
import type { ConnectionConfig } from "@/types/database";
import type { UserSkillsListResult } from "@/types/userSkills";

const SKILL = { id: "d-review", name: "sql-review", description: "review rules" };
const catalog: UserSkillsListResult = { defaultRoot: { status: "ok", skills: [SKILL] }, customRoot: null };

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const empty = () => Promise.resolve([]);
  return {
    ...actual,
    loadAiConversations: empty,
    loadAiRuns: empty,
    saveAiConversation: () => Promise.resolve(),
    listUserSkills: () => Promise.resolve(catalog),
    readUserSkills: empty,
    loadAiConfigs: empty,
    listPlugins: empty,
    loadPromptTemplates: empty,
    getAiGlobalCustomInstructions: () => Promise.resolve(""),
    saveAiChatSelection: () => Promise.resolve(),
    loadAiChatSelection: () => Promise.resolve(null),
    listSchemas: empty,
    listTables: empty,
    getColumns: empty,
    listIndexes: empty,
    listForeignKeys: empty,
  };
});

const POSTGRES: ConnectionConfig = { id: "postgres", name: "PostgreSQL", db_type: "postgres", host: "localhost", port: 5432, username: "", password: "", database: "app" };

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Browser-faithful `focus()`: a plain element without a tabindex cannot take focus. */
function stubBrowserFocus(): void {
  const realFocus = HTMLElement.prototype.focus;
  const spy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, ...args: [FocusOptions?]) {
    const focusable = this instanceof HTMLButtonElement || this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement || this instanceof HTMLSelectElement || this instanceof HTMLAnchorElement || this.hasAttribute("tabindex") || this.isContentEditable;
    if (!focusable) return;
    return realFocus.apply(this, args);
  });
  cleanups.push(() => spy.mockRestore());
}

async function mountPanel(): Promise<{ container: HTMLElement; pinia: Pinia }> {
  const pinia = createPinia();
  const app = createApp({ render: () => h(TooltipProvider, () => h(AiAssistant, { connection: POSTGRES })) });
  app.use(pinia);
  app.use(i18n);
  app.config.warnHandler = () => {};
  const settings = useSettingsStore(pinia);
  settings.isAiConfigLoaded = true;
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
  useConnectionStore(pinia).connections = [POSTGRES];
  const container = document.createElement("div");
  document.body.append(container);
  app.mount(container);
  cleanups.push(() => {
    app.unmount();
    container.remove();
  });
  await settle();
  return { container, pinia };
}

describe("AiAssistant /skill palette entry (real popover)", () => {
  it("keeps the skill selector open after picking /skill from the palette", async () => {
    stubBrowserFocus();
    const { container, pinia } = await mountPanel();
    // The user's precondition: the skill catalog is already loaded, so the popover
    // opens with its rows instead of the "Loading skills…" placeholder.
    await useUserSkillStore(pinia).refresh({ customRootEnabled: false, customRoot: null });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea.ai-conversation-text")!;
    textarea.focus();
    textarea.value = "/skill";
    textarea.setSelectionRange(6, 6);
    textarea.dispatchEvent(new Event("input"));
    await settle();

    const paletteEntry = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("/skill"));
    expect(paletteEntry, "/skill palette entry").toBeDefined();
    // Nothing is open yet, so whatever is found next came from the palette click.
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    paletteEntry!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await settle();

    // The typed command text is consumed either way; the popover is the assertion
    // that failed before the fix (it opened, then reka dismissed it on the
    // textarea focus that used to follow).
    expect(textarea.value).toBe("");
    const popover = document.querySelector('[role="dialog"]');
    expect(popover, "skill selector popover").not.toBeNull();
    expect(popover!.textContent).toContain(i18n.global.t("ai.skillsGroupDefault"));
    expect(popover!.textContent).toContain(SKILL.name);
  });
});
