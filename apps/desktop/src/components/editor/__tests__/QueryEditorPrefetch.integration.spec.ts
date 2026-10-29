// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import QueryEditor from "../QueryEditor.vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import type { QueryEditorProps } from "../queryEditorTypes";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

describe("QueryEditor completion prefetch integration", () => {
  it.each(["enabled", "disabled", "offline"] as const)("keeps the actual editor usable with %s prefetch", async (mode) => {
    const pinia = createPinia();
    setActivePinia(pinia);
    useSettingsStore().editorSettings.showExecutionTargetPicker = false;
    const store = useConnectionStore();
    const fetch = vi.spyOn(store, "listCompletionTables").mockResolvedValue([]);
    if (mode === "offline") fetch.mockRejectedValue(new Error("offline"));
    const props = reactive<QueryEditorProps>({ modelValue: "SELECT 1;", connectionId: "prefetch-test", database: "first", databaseType: "mysql", dialect: "mysql", tabId: "prefetch-test", prefetchCompletion: mode !== "disabled", autoFocus: false, hideExecutionControls: true });
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({ render: () => h(QueryEditor, { ...props, "onUpdate:modelValue": (value: string) => (props.modelValue = value) }) });
    app.use(pinia);
    app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
    cleanups.push(() => {
      app.unmount();
      host.remove();
    });
    app.mount(host);
    await vi.waitFor(() => expect(host.querySelector(".cm-editor")).not.toBeNull(), { timeout: 5000 });
    const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    expect(view.state.doc.toString()).toBe("SELECT 1;");
    if (mode === "disabled") {
      expect(fetch).not.toHaveBeenCalled();
    } else {
      expect(fetch).toHaveBeenCalledWith("prefetch-test", "first", "", expect.any(Number), undefined, false, undefined, undefined, { activateConnection: false });
      props.database = "second";
      await nextTick();
      expect(fetch).toHaveBeenCalledWith("prefetch-test", "second", "", expect.any(Number), undefined, false, undefined, undefined, { activateConnection: false });
    }
    view.dispatch({ changes: { from: view.state.doc.length, insert: " -- editable" } });
    await nextTick();
    expect(props.modelValue).toBe("SELECT 1; -- editable");
  });
});
