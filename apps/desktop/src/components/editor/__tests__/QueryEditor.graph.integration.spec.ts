// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, shallowRef } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { language } from "@codemirror/language";
import { EditorView, showTooltip } from "@codemirror/view";
import { toggleLineComment } from "@codemirror/commands";
import { acceptCompletion, completionStatus, currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { afterEach, describe, expect, it, vi } from "vitest";
import QueryEditor from "../QueryEditor.vue";
import type { QueryEditorProps } from "../queryEditorTypes";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";

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
  const props = reactive<QueryEditorProps>({ modelValue: "S", connectionId: "language-test", databaseType: "qdrant", dialect: "mysql", autoFocus: false, ...overrides });
  const editor = shallowRef<InstanceType<typeof QueryEditor>>();
  const onExecute = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(QueryEditor, {
        ...props,
        ref: editor,
        onExecute,
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
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
  return { editor: editor.value!, view, props, host, onExecute, settings };
}

import { graphQueryDatabases, graphQueryProfile, isGraphQueryDatabase } from "@/lib/graph/graphQueryProfiles";

describe.each(graphQueryDatabases)("QueryEditor %s native graph completion", (databaseType) => {
  it("automatically opens native keywords and inserts the accepted candidate", async () => {
    const { view, settings } = await mountEditor({ databaseType, modelValue: "" });
    settings.editorSettings.completionTriggerMode = "require-prefix";
    await nextTick();
    view.dispatch({ changes: { from: 0, insert: "mat" }, selection: { anchor: 3 }, userEvent: "input.type" });
    await vi.waitFor(() => expect(currentCompletions(view.state).map((item) => item.label)).toContain("MATCH"));
    expect(currentCompletions(view.state).map((item) => item.label)).not.toContain("SELECT");
    await vi.waitFor(() => expect(acceptCompletion(view)).toBe(true));
    expect(view.state.doc.toString().trim()).toBe("MATCH");
  });

  it("keeps automatic completion disabled in manual mode", async () => {
    const { view } = await mountEditor({ databaseType, modelValue: "" });
    view.dispatch({ changes: { from: 0, insert: "mat" }, selection: { anchor: 3 }, userEvent: "input.type" });
    expect(currentCompletions(view.state)).toEqual([]);
    startCompletion(view);
    await vi.waitFor(() => expect(currentCompletions(view.state).map((item) => item.label)).toContain("MATCH"));
  });

  it("inserts multiple native parameters and reuses existing argument lists", async () => {
    const { view, props } = await mountEditor({ databaseType, modelValue: "RETURN rep" });
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    startCompletion(view);
    await vi.waitFor(() => expect(currentCompletions(view.state)[0]?.label).toBe("replace"));
    await vi.waitFor(() => expect(acceptCompletion(view)).toBe(true));
    expect(view.state.doc.toString()).toBe("RETURN replace(string, search, replacement)");
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("string");
    props.modelValue = "RETURN rep_old ('a', 'b', 'c')";
    await nextTick();
    view.dispatch({ selection: { anchor: "RETURN rep".length } });
    startCompletion(view);
    await vi.waitFor(() => expect(currentCompletions(view.state)[0]?.label).toBe("replace"));
    await vi.waitFor(() => expect(acceptCompletion(view)).toBe(true));
    expect(view.state.doc.toString()).toBe("RETURN replace ('a', 'b', 'c')");
  });

  it("uses configured function casing, empty placeholders and parameter highlighting", async () => {
    const { view, settings } = await mountEditor({ databaseType, modelValue: "RETURN rep" });
    settings.editorSettings.sqlFormatter.functionCase = "upper";
    settings.editorSettings.functionCompletionIncludeParams = false;
    await nextTick();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    startCompletion(view);
    await vi.waitFor(() => expect(currentCompletions(view.state)[0]?.label).toBe("REPLACE"));
    await vi.waitFor(() => expect(acceptCompletion(view)).toBe(true));
    expect(view.state.doc.toString()).toBe("RETURN REPLACE()");
    expect(view.state.selection.main.head).toBe("RETURN REPLACE(".length);
    const tooltip = view.state.facet(showTooltip).filter(Boolean)[0]!;
    const dom = tooltip.create(view).dom;
    expect(dom.textContent).toContain("REPLACE(string, search, replacement)");
    expect(dom.querySelector('[data-active-parameter="true"]')?.textContent).toBe("string");
  });

  it("resolves renamed node metadata and replaces the remaining word without a trailing space", async () => {
    const source = databaseType === "nebula" ? "MATCH (n:Person) WITH n AS p RETURN p.Person.name" : "MATCH (n:Person) WITH n AS p RETURN p.name";
    const { view, settings } = await mountEditor({ databaseType, database: "synthetic", modelValue: source });
    settings.editorSettings.insertSpaceAfterCompletion = true;
    const columns = vi.spyOn(useConnectionStore(), "listCompletionColumns").mockResolvedValue([{ name: "name", table: "Person", dataType: "string" }]);
    view.dispatch({ selection: { anchor: source.length - 2 } });
    startCompletion(view);
    await vi.waitFor(() => expect(currentCompletions(view.state)[0]?.label).toBe("name"));
    expect(columns).toHaveBeenCalledWith("language-test", "synthetic", "Person");
    await vi.waitFor(() => expect(acceptCompletion(view)).toBe(true));
    expect(view.state.doc.toString()).toBe(source);
  });

  it("completes quoted graph labels without duplicating delimiters", async () => {
    const source = "MATCH (n:`Per-old`)";
    const { view } = await mountEditor({ databaseType, database: "synthetic", modelValue: source });
    vi.spyOn(useConnectionStore(), "listCompletionTables").mockResolvedValue([{ name: "Person", type: "table" }]);
    view.dispatch({ selection: { anchor: source.indexOf("Per") + 3 } });
    startCompletion(view);
    await vi.waitFor(() => expect(currentCompletions(view.state)[0]?.label).toBe("Person"));
    await vi.waitFor(() => expect(acceptCompletion(view)).toBe(true));
    expect(view.state.doc.toString()).toBe("MATCH (n:`Person`)");
  });

  it("discards stale graph metadata when the connection changes", async () => {
    const { view, props } = await mountEditor({ databaseType, database: "synthetic", modelValue: "MATCH (n:" });
    let resolve!: (tables: Array<{ name: string }>) => void;
    const pending = new Promise<Array<{ name: string }>>((done) => {
      resolve = done;
    });
    const tables = vi.spyOn(useConnectionStore(), "listCompletionTables").mockImplementation((connectionId) => (connectionId === "language-test" ? pending : Promise.resolve([])));
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    startCompletion(view);
    await vi.waitFor(() => expect(tables).toHaveBeenCalled());
    props.connectionId = "another-connection";
    await nextTick();
    resolve([{ name: "OldConnectionLabel" }]);
    await vi.waitFor(() => expect(completionStatus(view.state)).not.toBe("pending"));
    expect(currentCompletions(view.state).map((item) => item.label)).not.toContain("OldConnectionLabel");
  });

  it("uses native comments and hides function hints in comments", async () => {
    const source = "RETURN sum(";
    const { view } = await mountEditor({ databaseType, modelValue: source, initialSelection: { anchor: source.length, head: source.length } });
    expect(view.state.facet(showTooltip).filter(Boolean)).not.toEqual([]);
    expect(toggleLineComment(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(graphQueryProfile(databaseType).lineComment + " " + source);
    expect(view.state.facet(showTooltip).filter(Boolean)).toEqual([]);
  });

  it("honors custom snippets and excluded completion items", async () => {
    const { view, props, settings } = await mountEditor({ databaseType, modelValue: "gq" });
    settings.editorSettings.snippets = [{ id: "custom-graph", prefix: "gq", label: "Find Person", body: "MATCH (p:Person) RETURN p" }];
    await nextTick();
    view.dispatch({ selection: { anchor: 2 } });
    startCompletion(view);
    await vi.waitFor(() => expect(currentCompletions(view.state)[0]?.label).toBe("gq Find Person"));
    await vi.waitFor(() => expect(acceptCompletion(view)).toBe(true));
    expect(view.state.doc.toString().trim()).toBe("MATCH (p:Person) RETURN p");
    settings.editorSettings.excludedCompletionItems = ["replace"];
    props.modelValue = "RETURN rep";
    await nextTick();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    startCompletion(view);
    await vi.waitFor(() => expect(completionStatus(view.state)).not.toBe("pending"));
    expect(currentCompletions(view.state).map((item) => item.label)).not.toContain("replace");
  });

  it("restores SQL completion and signatures after changing database type", async () => {
    const { view, props } = await mountEditor({ databaseType, modelValue: "mat" });
    view.dispatch({ selection: { anchor: 3 } });
    startCompletion(view);
    await vi.waitFor(() => expect(currentCompletions(view.state).map((item) => item.label)).toContain("MATCH"));
    props.databaseType = "mysql";
    props.modelValue = "S";
    await nextTick();
    view.dispatch({ selection: { anchor: 1 } });
    startCompletion(view);
    await vi.waitFor(() => expect(currentCompletions(view.state).map((item) => item.label)).toContain("SELECT"));
    props.modelValue = "SELECT GROUP_CONCAT(";
    await nextTick();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(view.state.facet(showTooltip).filter(Boolean)).not.toEqual([]);
    props.databaseType = databaseType;
    await nextTick();
    expect(view.state.facet(showTooltip).filter(Boolean)).toEqual([]);
  });
});

it("does not enable a graph dialect whose profile is absent", async () => {
  for (const databaseType of ["neo4j", "nebula"] as const) {
    if (isGraphQueryDatabase(databaseType)) continue;
    const { view } = await mountEditor({ databaseType, modelValue: "S" });
    expect(view.state.facet(language)).not.toBeNull();
    view.dispatch({ selection: { anchor: 1 } });
    startCompletion(view);
    await vi.waitFor(() => expect(currentCompletions(view.state).map((item) => item.label)).toContain("SELECT"));
  }
});
