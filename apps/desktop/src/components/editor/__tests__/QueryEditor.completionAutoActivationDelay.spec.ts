// @vitest-environment happy-dom

import { createApp, h, reactive, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import QueryEditor from "../QueryEditor.vue";
import { normalizeEditorSettings, useSettingsStore } from "@/stores/settingsStore";

// Capture the config the editor hands to CodeMirror's autocompletion so the
// DBeaver-style activation delay (#15340) can be asserted end to end.
const capturedAutocompletionConfigs: Array<Parameters<typeof import("@codemirror/autocomplete").autocompletion>[0]> = [];

vi.mock("@codemirror/autocomplete", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codemirror/autocomplete")>();
  return {
    ...actual,
    autocompletion: (config: Parameters<typeof actual.autocompletion>[0]) => {
      capturedAutocompletionConfigs.push(config);
      return actual.autocompletion({
        ...config,
        interactionDelay: 0,
        override: [(context) => ({ from: context.pos, options: [{ label: "candidate" }] })],
      });
    },
  };
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  capturedAutocompletionConfigs.length = 0;
});

async function mountEditor() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const state = reactive({ sql: "" });
  const host = document.createElement("div");
  document.body.append(host);
  const app: App = createApp({
    render: () =>
      h(QueryEditor, {
        modelValue: state.sql,
        tabId: "completion-auto-activation-delay",
        databaseType: "mysql",
        dialect: "mysql",
        autoFocus: false,
        "onUpdate:modelValue": (value: string) => {
          state.sql = value;
        },
      }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  await vi.waitFor(() => expect(host.querySelector(".cm-editor")).not.toBeNull(), { timeout: 5000 });
  return EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
}

function lastConfig(): Parameters<typeof import("@codemirror/autocomplete").autocompletion>[0] {
  expect(capturedAutocompletionConfigs.length).toBeGreaterThan(0);
  return capturedAutocompletionConfigs[capturedAutocompletionConfigs.length - 1]!;
}

describe("completion auto-activation delay (#15340)", () => {
  it("opens the extension with the 500 ms default delay", async () => {
    await mountEditor();
    expect(lastConfig().activateOnTyping).toBe(true);
    expect(lastConfig().activateOnTypingDelay).toBe(500);
  });

  it("rebuilds the extension when the delay setting changes", async () => {
    await mountEditor();
    const settings = useSettingsStore();
    settings.editorSettings.completionAutoActivationDelayMs = 1234;
    await vi.waitFor(() => expect(lastConfig().activateOnTypingDelay).toBe(1234));
  });

  it("normalizes persisted values into the 0–5000 ms range", () => {
    expect(normalizeEditorSettings({}).completionAutoActivationDelayMs).toBe(500);
    expect(normalizeEditorSettings({ completionAutoActivationDelayMs: 1234 }).completionAutoActivationDelayMs).toBe(1234);
    expect(normalizeEditorSettings({ completionAutoActivationDelayMs: -5 }).completionAutoActivationDelayMs).toBe(0);
    expect(normalizeEditorSettings({ completionAutoActivationDelayMs: 99999 }).completionAutoActivationDelayMs).toBe(5000);
    expect(normalizeEditorSettings({ completionAutoActivationDelayMs: "600" as unknown as number }).completionAutoActivationDelayMs).toBe(500);
  });
});
