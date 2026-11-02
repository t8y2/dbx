// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { EditorView } from "@codemirror/view";
import { insertNewlineAndIndent, undo } from "@codemirror/commands";
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

async function mountEditor(readOnly: boolean) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSettingsStore().editorSettings.showExecutionTargetPicker = false;
  useConnectionStore();
  const props = reactive<QueryEditorProps>({ modelValue: "SELECT 1;", tabId: "source-a", databaseType: "oceanbase-oracle", dialect: "oracle", autoFocus: false, hideExecutionControls: true, readOnly });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(QueryEditor, { ...props, "onUpdate:modelValue": (value: string) => (props.modelValue = value) }) });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  await vi.waitFor(() => expect(host.querySelector(".cm-editor")).not.toBeNull(), { timeout: 5000 });
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
  return { props, view };
}

function expectReadOnly(view: EditorView, readOnly: boolean) {
  expect(view.state.readOnly).toBe(readOnly);
  expect(view.state.facet(EditorView.editable)).toBe(!readOnly);
  expect(view.contentDOM.getAttribute("contenteditable")).toBe(String(!readOnly));
}

describe("QueryEditor controlled source editing", () => {
  it("applies explicit editing and returns to read-only without replacing the view, draft or undo history", async () => {
    const { props, view } = await mountEditor(true);
    expectReadOnly(view, true);
    expect(insertNewlineAndIndent(view)).toBe(false);
    props.readOnly = false;
    await nextTick();
    expectReadOnly(view, false);
    expect(insertNewlineAndIndent(view)).toBe(true);
    await nextTick();
    const edited = view.state.doc.toString();
    props.readOnly = true;
    await nextTick();
    expectReadOnly(view, true);
    expect(insertNewlineAndIndent(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(edited);
    props.readOnly = false;
    await nextTick();
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("SELECT 1;");
  });

  it.each([true, false])("rechecks a cached read-only=%s tab when the active prop does not change", async (cachedReadOnly) => {
    const { props, view } = await mountEditor(cachedReadOnly);
    props.tabId = "source-b";
    props.modelValue = "SELECT 2;";
    await nextTick();
    props.readOnly = !cachedReadOnly;
    await nextTick();
    expectReadOnly(view, !cachedReadOnly);
    props.tabId = "source-a";
    props.modelValue = "SELECT 1;";
    await nextTick();
    expectReadOnly(view, !cachedReadOnly);
    expect(view.state.doc.toString()).toBe("SELECT 1;");
  });
});
