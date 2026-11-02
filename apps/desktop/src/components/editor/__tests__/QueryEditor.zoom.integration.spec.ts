// @vitest-environment happy-dom

import { createApp, h } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import QueryEditor from "../QueryEditor.vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  useToast().dismissToast();
  vi.restoreAllMocks();
});

async function mountEditor() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settings = useSettingsStore();
  settings.editorSettings.showExecutionTargetPicker = false;
  settings.editorSettings.fontSize = 13;
  settings.editorSettings.uiScale = 1;
  useConnectionStore();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(QueryEditor, { modelValue: "SELECT 1;", tabId: "zoom-query", autoFocus: false, hideExecutionControls: true }) });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  await vi.waitFor(() => expect(host.querySelector(".cm-editor")).not.toBeNull());
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
  const root = host.querySelector<HTMLElement>("[data-query-editor-root]")!;
  return { settings, view, fontSize: () => root.style.getPropertyValue("--dbx-editor-font-size") };
}

function wheel(view: EditorView, timeStamp: number, init: WheelEventInit) {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  // happy-dom's WheelEvent does not yet inherit MouseEvent's modifier fields.
  Object.defineProperties(event, {
    timeStamp: { value: timeStamp },
    ctrlKey: { value: init.ctrlKey ?? false },
    metaKey: { value: init.metaKey ?? false },
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

describe("QueryEditor wheel zoom", () => {
  it.each(["Control", "Meta"])("bounds fractional %s + wheel input, reports the percentage and saves the font size", async (key) => {
    const { settings, view, fontSize } = await mountEditor();
    const modifiers = { ctrlKey: key === "Control", metaKey: key === "Meta" };
    // The key can be pressed outside the editor before the pointer enters it.
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...modifiers }));
    const event = wheel(view, 100, { deltaY: -100.5, ...modifiers });
    expect(event.defaultPrevented).toBe(true);
    expect(fontSize()).toBe("13.65px");
    expect(useToast().message.value).toBe("105%");
    expect(view.state.doc.toString()).toBe("SELECT 1;");
    expect(settings.editorSettings.uiScale).toBe(1);
    await vi.waitFor(() => expect(settings.editorSettings.fontSize).toBe(13.65));

    wheel(view, 200, { deltaY: 100.5, ...modifiers });
    expect(fontSize()).toBe("13px");
    expect(useToast().message.value).toBe("100%");
    await vi.waitFor(() => expect(settings.editorSettings.fontSize).toBe(13));
  });

  it("leaves plain scrolling alone and preserves pinch scaling after key release and window blur", async () => {
    const { view, fontSize } = await mountEditor();
    expect(wheel(view, 100, { deltaY: -120 }).defaultPrevented).toBe(false);
    expect(fontSize()).toBe("13px");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Control", bubbles: true }));
    wheel(view, 500, { deltaY: -100 * Math.log(1.2), ctrlKey: true });
    expect(fontSize()).toBe("15.6px");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true, bubbles: true }));
    window.dispatchEvent(new Event("blur"));
    wheel(view, 900, { deltaY: -100 * Math.log(1.2), ctrlKey: true });
    expect(fontSize()).toBe("18.72px");
  });
});
