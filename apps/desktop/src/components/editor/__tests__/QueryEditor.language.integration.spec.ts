// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, shallowRef } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { language, syntaxTree } from "@codemirror/language";
import { EditorView, showTooltip } from "@codemirror/view";
import { toggleLineComment, undo } from "@codemirror/commands";
import { completionStatus, currentCompletions, startCompletion } from "@codemirror/autocomplete";
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

function expectPlainText(view: EditorView) {
  expect(view.state.facet(language)).toBeNull();
  expect(view.state.languageDataAt("autocomplete", 0)).toEqual([]);
  expect(startCompletion(view)).toBe(false);
  expect(completionStatus(view.state)).toBeNull();
  expect(currentCompletions(view.state)).toEqual([]);
}

async function expectSqlCompletion(view: EditorView) {
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  expect(startCompletion(view)).toBe(true);
  await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
  expect(currentCompletions(view.state).map((option) => option.label)).toEqual(expect.arrayContaining(["SELECT", "SUM", "SUBSTR"]));
}

describe("QueryEditor language capabilities", () => {
  it("does not install SQL grammar or expose SQL completions for Qdrant", async () => {
    const { view } = await mountEditor();
    expectPlainText(view);
  });

  it("does not offer SQL function signatures for Qdrant", async () => {
    const { view } = await mountEditor({ modelValue: "SELECT SUM(", initialSelection: { anchor: 11, head: 11 } });
    expect(view.state.facet(showTooltip).filter(Boolean)).toEqual([]);
  });

  it.each(["mysql", "postgres", "jdbc", undefined] as const)("preserves SQL grammar and completion for %s", async (databaseType) => {
    const { view, props } = await mountEditor({ databaseType, dialect: databaseType === "postgres" ? "postgres" : "mysql" });
    expect(view.state.facet(language)).not.toBeNull();
    expect(view.state.languageDataAt("autocomplete", 0)).not.toEqual([]);
    await expectSqlCompletion(view);
    props.modelValue = "SELECT SUM(";
    await nextTick();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(syntaxTree(view.state).resolveInner(3).name).toBe("Keyword");
    expect(view.state.facet(showTooltip).filter(Boolean)).not.toEqual([]);
  });

  it("clears active SQL completion on a connection type change and restores it on return", async () => {
    const { view, props, host } = await mountEditor({ databaseType: "mysql" });
    await expectSqlCompletion(view);
    props.databaseType = "qdrant";
    await nextTick();
    expectPlainText(view);
    expect(view.state.doc.toString()).toBe("S");
    props.databaseType = "mysql";
    await nextTick();
    await expectSqlCompletion(view);
    expect(host.querySelector(".cm-editor")).toBe(view.dom);
  });

  it("keeps the Qdrant language gate when cached editor tabs are restored", async () => {
    const { view, props } = await mountEditor({ tabId: "qdrant-tab" });
    expectPlainText(view);
    props.tabId = "sql-tab";
    props.databaseType = "mysql";
    await nextTick();
    await expectSqlCompletion(view);
    props.tabId = "qdrant-tab";
    props.databaseType = "qdrant";
    await nextTick();
    expectPlainText(view);
  });

  it("reconfigures a cached SQL tab reassigned to Qdrant even when the active database type stays the same", async () => {
    const { view, props } = await mountEditor({ tabId: "reassigned-tab", databaseType: "mysql" });
    await expectSqlCompletion(view);
    props.tabId = "qdrant-tab";
    props.databaseType = "qdrant";
    await nextTick();
    expectPlainText(view);
    props.tabId = "reassigned-tab";
    await nextTick();
    expectPlainText(view);
  });

  it("keeps SQL completion disabled after completion settings change", async () => {
    const { view, settings } = await mountEditor();
    settings.editorSettings.selectFirstCompletionOnOpen = !settings.editorSettings.selectFirstCompletionOnOpen;
    await nextTick();
    expectPlainText(view);
  });

  it("preserves MongoDB shell comments when switching from Qdrant", async () => {
    const { view, props } = await mountEditor({ modelValue: "db.items.find({})" });
    props.databaseType = "mongodb";
    await nextTick();
    expect(toggleLineComment(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("// db.items.find({})");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("db.items.find({})");
  });

  it.each([false, true])("preserves Qdrant clipboard input and read-only behavior (readOnly: %s)", async (readOnly) => {
    const { view } = await mountEditor({ modelValue: "", readOnly });
    const request = '{"collection":"items","limit":10}';
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => (type === "text/plain" ? request : ""), files: [] } });
    view.contentDOM.dispatchEvent(event);
    await nextTick();
    expect(view.state.doc.toString()).toBe(readOnly ? "" : request);
    expectPlainText(view);
  });

  it("preserves JSON editing, comments, undo, selection and execution for Qdrant", async () => {
    const request = '{"collection":"items","limit":10}';
    const { view, editor, onExecute } = await mountEditor({ modelValue: request });
    const limit = request.indexOf("10");
    view.dispatch({ changes: { from: limit, to: limit + 2, insert: "20" }, userEvent: "input" });
    expect(view.state.doc.toString()).toBe(request.replace("10", "20"));
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(request);
    expect(toggleLineComment(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(`-- ${request}`);
    expect(undo(view)).toBe(true);
    view.dispatch({ selection: { anchor: 0, head: request.length } });
    expect(editor.captureExecutionSnapshot()?.selectedSql).toBe(request);
    expect(editor.requestExecute({ bypassPicker: true })).toBe(true);
    expect(onExecute.mock.lastCall?.[0].selectedSql).toBe(request);
    expect(view.state.doc.toString()).toBe(request);
  });
});
