// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { acceptCompletion, currentCompletions, setSelectedCompletion, startCompletion } from "@codemirror/autocomplete";
import { afterEach, describe, expect, it, vi } from "vitest";
import QueryEditor from "../QueryEditor.vue";
import type { QueryEditorProps } from "../queryEditorTypes";
import { useSettingsStore } from "@/stores/settingsStore";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

async function mountEditor(overrides: Partial<QueryEditorProps> = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settings = useSettingsStore();
  settings.editorSettings.showExecutionTargetPicker = false;
  settings.editorSettings.completionTriggerMode = "manual";
  const props = reactive<QueryEditorProps>({ modelValue: "", connectionId: "multi-cursor-snippet", databaseType: "mysql", dialect: "mysql", autoFocus: false, ...overrides });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(QueryEditor, {
        ...props,
        "onUpdate:modelValue": (value: string) => {
          props.modelValue = value;
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
  return { view: EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!, settings, props };
}

describe("QueryEditor multi-cursor snippets", () => {
  it("expands the accepted snippet on every rectangular cursor", async () => {
    const { view, settings } = await mountEditor();
    settings.editorSettings.snippets = [{ id: "multi-sf", prefix: "sf", label: "select from table", body: "select * from ${1:table_name};" }];
    const lines = ["sfhd_dwd.a", "sfhd_dwd.b", "sfhd_dwd.c"];
    const doc = lines.join("\n");
    const cursors: number[] = [];
    let offset = 0;
    for (const line of lines) {
      cursors.push(offset + 2);
      offset += line.length + 1;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc },
      selection: EditorSelection.create(
        cursors.map((position) => EditorSelection.cursor(position)),
        0,
      ),
    });
    await nextTick();

    startCompletion(view);
    await vi.waitFor(() => expect(currentCompletions(view.state).some((item) => item.type === "snippet")).toBe(true));
    const snippetIndex = currentCompletions(view.state).findIndex((item) => item.type === "snippet");
    view.dispatch({ effects: setSelectedCompletion(snippetIndex) });
    await vi.waitFor(() => expect(acceptCompletion(view)).toBe(true));

    expect(view.state.doc.toString()).toBe(lines.map((line) => `select * from table_name;${line.slice(2)}`).join("\n"));
  });

  it("leaves cursors without the typed prefix untouched", async () => {
    const { view, settings } = await mountEditor();
    settings.editorSettings.snippets = [{ id: "multi-sf", prefix: "sf", label: "select from table", body: "select * from ${1:table_name};" }];
    const doc = "sfhd_dwd.a\nxxhd_dwd.b";
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc },
      selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(doc.indexOf("xx") + 2)], 0),
    });
    await nextTick();

    startCompletion(view);
    await vi.waitFor(() => expect(currentCompletions(view.state).some((item) => item.type === "snippet")).toBe(true));
    const snippetIndex = currentCompletions(view.state).findIndex((item) => item.type === "snippet");
    view.dispatch({ effects: setSelectedCompletion(snippetIndex) });
    await vi.waitFor(() => expect(acceptCompletion(view)).toBe(true));

    expect(view.state.doc.toString()).toBe("select * from table_name;hd_dwd.a\nxxhd_dwd.b");
  });
});
