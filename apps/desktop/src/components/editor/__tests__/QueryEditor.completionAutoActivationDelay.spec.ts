// @vitest-environment happy-dom

import { createApp, h, reactive, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { Transaction } from "@codemirror/state";
import { completionStatus } from "@codemirror/autocomplete";
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
  vi.useRealTimers();
});

async function mountEditor(delay?: number) {
  const pinia = createPinia();
  setActivePinia(pinia);
  if (delay !== undefined) useSettingsStore().editorSettings.completionAutoActivationDelayMs = delay;
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

  it.each(["input.type", "input.paste"])("waits after the last %s edit before opening the popup", async (event) => {
    const view = await mountEditor(2000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const insert = (text: string, pos: number) =>
      view.dispatch({
        changes: { from: pos, insert: text },
        selection: { anchor: pos + text.length },
        annotations: Transaction.userEvent.of(event),
      });
    insert("SE", 0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(completionStatus(view.state)).not.toBe("active");
    insert("L", 2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(completionStatus(view.state)).not.toBe("active");
    await vi.advanceTimersByTimeAsync(250);
    expect(completionStatus(view.state)).toBe("active");
  });

  it.each([false, true])("handles Alt+/ with IME composing=%s", async (isComposing) => {
    const view = await mountEditor(2000);
    view.focus();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    if (isComposing) view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const event = new KeyboardEvent("keydown", { key: "/", code: "Slash", altKey: true, isComposing, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);

    if (isComposing) {
      expect(event.defaultPrevented).toBe(false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(completionStatus(view.state)).toBeNull();
    } else {
      expect(event.defaultPrevented).toBe(true);
      expect(completionStatus(view.state)).toBe("pending");
      await vi.advanceTimersByTimeAsync(100);
      expect(completionStatus(view.state)).toBe("active");
    }
  });

  it("normalizes persisted values into the 0–5000 ms range", () => {
    expect(normalizeEditorSettings({}).completionAutoActivationDelayMs).toBe(500);
    expect(normalizeEditorSettings({ completionAutoActivationDelayMs: 1234 }).completionAutoActivationDelayMs).toBe(1234);
    expect(normalizeEditorSettings({ completionAutoActivationDelayMs: -5 }).completionAutoActivationDelayMs).toBe(0);
    expect(normalizeEditorSettings({ completionAutoActivationDelayMs: 99999 }).completionAutoActivationDelayMs).toBe(5000);
    expect(normalizeEditorSettings({ completionAutoActivationDelayMs: "600" as unknown as number }).completionAutoActivationDelayMs).toBe(500);
  });
});
