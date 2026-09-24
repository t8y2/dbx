// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, shallowRef } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { toggleLineComment, undo } from "@codemirror/commands";
import { closeCompletion, completionStatus, currentCompletions, selectedCompletionIndex, startCompletion } from "@codemirror/autocomplete";
import { afterEach, describe, expect, it, vi } from "vitest";
import QueryEditor from "../QueryEditor.vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { createTableReferenceDropEvent, createTableReferenceHoverEvent, setActiveTableReferencePayload, type QueryEditorTableReferencePayload } from "@/lib/editor/queryEditorTableDrop";
import type { QueryEditorProps } from "../queryEditorTypes";
import { focusedQueryEditorView, queryEditorInsertContext } from "@/lib/editor/focusedQueryEditorView";

vi.mock("@/lib/common/clipboard", () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
  readTextFromClipboard: vi.fn().mockResolvedValue("alice\nbob"),
}));

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  setActiveTableReferencePayload(null);
  vi.restoreAllMocks();
});

async function mountEditor(overrides: Partial<QueryEditorProps> = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  const connectionStore = useConnectionStore();
  settingsStore.editorSettings.showExecutionTargetPicker = false;
  settingsStore.editorSettings.executeMode = "current";
  settingsStore.editorSettings.executeAllOnBlankLine = false;
  const props = reactive<QueryEditorProps>({ modelValue: "SELECT 1;\nSELECT 2;", tabId: "split-a", databaseType: "mysql", dialect: "mysql", autoFocus: false, ...overrides });
  const editor = shallowRef<InstanceType<typeof QueryEditor>>();
  const onExecute = vi.fn();
  const onExecuteInNewResultTab = vi.fn();
  const onClickTable = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(QueryEditor, {
        ...props,
        ref: editor,
        onExecute,
        onExecuteInNewResultTab,
        onClickTable,
        "onUpdate:modelValue": (value: string) => {
          props.modelValue = value;
        },
      }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    app.unmount();
    host.remove();
  };
  cleanups.push(unmount);
  await vi.waitFor(() => expect(host.querySelector(".cm-editor")).not.toBeNull(), { timeout: 5000 });
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
  return { editor: editor.value!, props, view, host, settingsStore, connectionStore, onExecute, onExecuteInNewResultTab, onClickTable, unmount };
}

function keydown(target: HTMLElement, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("QueryEditor component split integration", () => {
  it("preserves upstream structure-peek focus and insertion context across updates and unmount", async () => {
    const { view, props, unmount } = await mountEditor({ connectionId: "peek-a", database: "demo", schema: "public" });
    expect(queryEditorInsertContext(view)).toEqual({ connectionId: "peek-a", database: "demo", schema: "public", databaseType: "mysql" });
    view.focus();
    await nextTick();
    const panel = document.createElement("div");
    panel.setAttribute("data-structure-peek-panel", "");
    document.body.append(panel);
    cleanups.push(() => panel.remove());
    await vi.waitFor(() => expect(focusedQueryEditorView(panel)).toBe(view));
    props.connectionId = "peek-b";
    props.database = "updated";
    props.schema = "reporting";
    await nextTick();
    expect(queryEditorInsertContext(view)).toEqual({ connectionId: "peek-b", database: "updated", schema: "reporting", databaseType: "mysql" });
    unmount();
    expect(queryEditorInsertContext(view)).toBeUndefined();
    expect(focusedQueryEditorView(panel)).toBeNull();
  });

  it("preserves the public editor API and the direct CodeMirror host", async () => {
    const { editor, host, view } = await mountEditor();
    for (const method of [
      "openSearch",
      "openReplace",
      "scrollCursorIntoView",
      "beginExecutionViewportTracking",
      "acceptGutterExecutionViewport",
      "cancelGutterExecutionViewport",
      "shouldBlockExecutionShortcut",
      "requestExecute",
      "requestExecuteInNewResultTab",
      "requestPreviewChanges",
      "captureExecutionSnapshot",
      "pasteClipboardAsSqlInCondition",
      "focusStatementRange",
      "focusErrorPosition",
      "previewStatementRange",
      "refreshCompletionCache",
    ]) {
      expect(typeof editor[method as keyof typeof editor], method).toBe("function");
    }
    expect(host.querySelector("[data-query-editor-root] > .cm-editor")).toBe(view.dom);
    expect(host.querySelectorAll(".cm-editor")).toHaveLength(1);
    expect(editor.openSearch()).toBe(true);
    await nextTick();
    expect(host.querySelector(".cm-editor")).toBe(view.dom);
  });

  it.each(["current", "all"] as const)("keeps selection priority in %s mode and immutable toolbar snapshots", async (executeMode) => {
    const { editor, props, view, settingsStore, onExecute } = await mountEditor();
    settingsStore.editorSettings.executeMode = executeMode;
    view.dispatch({ selection: EditorSelection.range(10, 18) });
    const snapshot = editor.captureExecutionSnapshot();
    expect(snapshot).toEqual({ fullSql: props.modelValue, selectedSql: "SELECT 2", cursorPos: 18, selectionFrom: 10, selectionTo: 18 });
    expect(editor.requestExecute()).toBe(true);
    expect(onExecute).toHaveBeenLastCalledWith(snapshot);
    view.dispatch({ selection: { anchor: 0 } });
    expect(snapshot?.selectedSql).toBe("SELECT 2");
    expect(editor.captureExecutionSnapshot()).toBeUndefined();
  });

  it.each(["current", "all"] as const)("keeps %s execution ranges without a manual selection", async (executeMode) => {
    const { editor, props, view, settingsStore, onExecute } = await mountEditor();
    settingsStore.editorSettings.executeMode = executeMode;
    view.dispatch({ selection: { anchor: 12 } });
    expect(editor.requestExecute({ bypassPicker: true })).toBe(true);
    const source = onExecute.mock.calls[0][0];
    expect(source.fullSql).toBe(props.modelValue);
    expect(source.cursorPos).toBe(12);
    expect(source.selectedSql).toBe(executeMode === "current" ? "SELECT 2" : props.modelValue);
    expect(source.selectionFrom).toBe(executeMode === "current" ? 10 : 0);
    expect(source.selectionTo).toBe(executeMode === "current" ? 18 : props.modelValue.length);
  });

  it("keeps the new-result-tab shortcut independent of the optional picker", async () => {
    const { editor, host, settingsStore, onExecute, onExecuteInNewResultTab } = await mountEditor();
    settingsStore.editorSettings.showExecutionTargetPicker = true;
    expect(editor.requestExecuteInNewResultTab()).toBe(true);
    await nextTick();
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(onExecute).not.toHaveBeenCalled();
    expect(onExecuteInNewResultTab).toHaveBeenCalledTimes(1);
    expect(onExecuteInNewResultTab.mock.calls[0][0].selectedSql).toBe("SELECT 1");
  });

  it("opens, navigates, cancels and confirms the execution picker without replacing the editor", async () => {
    const { editor, host, view, props, settingsStore, onExecute } = await mountEditor();
    settingsStore.editorSettings.showExecutionTargetPicker = true;
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 10, right: 12, top: 20, bottom: 40 });
    vi.spyOn(host.querySelector("[data-query-editor-root]")!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 600));
    expect(editor.requestExecute()).toBe(true);
    await nextTick();
    let picker = host.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(picker).not.toBeNull();
    expect(picker.style.left).toBe("400px");
    expect(onExecute).not.toHaveBeenCalled();
    keydown(picker, "ArrowDown");
    await nextTick();
    expect(picker.querySelectorAll('[role="option"]')[1].getAttribute("aria-selected")).toBe("true");
    keydown(picker, "Escape");
    await nextTick();
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(onExecute).not.toHaveBeenCalled();
    expect(view.hasFocus).toBe(true);
    editor.requestExecute();
    await nextTick();
    picker = host.querySelector<HTMLElement>('[role="listbox"]')!;
    keydown(picker, "ArrowDown");
    await nextTick();
    keydown(picker, "Enter");
    await nextTick();
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute.mock.calls[0][0].selectedSql).toBe(props.modelValue);
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(host.querySelector(".cm-editor")).toBe(view.dom);
  });

  it.each(["redis", "mongodb", "elasticsearch"] as const)("preserves the non-SQL %s execution path", async (databaseType) => {
    const { editor, props, host, settingsStore, onExecute } = await mountEditor({ databaseType, modelValue: databaseType === "redis" ? "GET key" : "{}" });
    settingsStore.editorSettings.showExecutionTargetPicker = true;
    expect(editor.requestExecute()).toBe(true);
    await nextTick();
    expect(onExecute).toHaveBeenCalledWith({ fullSql: props.modelValue, selectedSql: databaseType === "mongodb" ? "" : props.modelValue, cursorPos: 0, selectionFrom: 0, selectionTo: databaseType === "mongodb" ? 0 : props.modelValue.length });
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(await editor.pasteClipboardAsSqlInCondition()).toBe(false);
  });

  it.each([false, true])("preserves the blank-line execution fallback setting (%s)", async (fallback) => {
    const { editor, view, props, settingsStore, onExecute } = await mountEditor({ modelValue: "SELECT 1;\n\nSELECT 2;" });
    settingsStore.editorSettings.executeAllOnBlankLine = fallback;
    view.dispatch({ selection: { anchor: 10 } });
    expect(editor.requestExecute()).toBe(true);
    expect(onExecute).toHaveBeenCalledTimes(fallback ? 1 : 0);
    if (fallback) expect(onExecute.mock.calls[0][0].selectedSql).toBe(props.modelValue);
  });

  it("reads current read-only props for extracted clipboard actions and keeps undo history", async () => {
    const { editor, props, view } = await mountEditor({ modelValue: "" });
    expect(await editor.pasteClipboardAsSqlInCondition()).toBe(true);
    expect(view.state.doc.toString()).toContain("'alice'");
    expect(view.state.doc.toString()).toContain("'bob'");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("");
    props.readOnly = true;
    await nextTick();
    expect(await editor.pasteClipboardAsSqlInCondition()).toBe(false);
    expect(view.state.doc.toString()).toBe("");
  });

  it("preserves per-tab undo isolation, external model updates and the editor instance", async () => {
    const { editor, props, view, host } = await mountEditor({ modelValue: "SELECT 1;" });
    view.dispatch({ changes: { from: 7, to: 8, insert: "10" }, userEvent: "input" });
    await nextTick();
    props.tabId = "split-b";
    props.modelValue = "SELECT 2;";
    await nextTick();
    expect(view.state.doc.toString()).toBe("SELECT 2;");
    expect(undo(view)).toBe(false);
    props.tabId = "split-a";
    props.modelValue = "SELECT 10;";
    await nextTick();
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("SELECT 1;");
    props.modelValue = "SELECT 3;";
    await nextTick();
    expect(view.state.doc.toString()).toBe("SELECT 3;");
    expect(editor.captureExecutionSnapshot()).toBeUndefined();
    expect(host.querySelector(".cm-editor")).toBe(view.dom);
  });

  it("connects manual completion to the provider without preselecting a candidate", async () => {
    const { view, settingsStore } = await mountEditor({ modelValue: "SEL", initialSelection: { anchor: 3, head: 3 }, connectionId: "completion-test" });
    settingsStore.editorSettings.completionTriggerMode = "manual";
    settingsStore.editorSettings.selectFirstCompletionOnOpen = false;
    await nextTick();
    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    expect(currentCompletions(view.state).map((option) => option.label)).toContain("SELECT");
    expect(selectedCompletionIndex(view.state)).toBeNull();
    expect(view.state.doc.toString()).toBe("SEL");
    expect(closeCompletion(view)).toBe(true);
  });

  it("reconfigures language and wrapping extensions without replacing the view", async () => {
    const { view, props, host } = await mountEditor({ modelValue: "SELECT 1" });
    expect(toggleLineComment(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("-- SELECT 1");
    props.databaseType = "mongodb";
    props.modelValue = "db.users.find({})";
    await nextTick();
    expect(toggleLineComment(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("// db.users.find({})");
    props.forceWordWrap = true;
    await nextTick();
    expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
    props.forceWordWrap = false;
    await nextTick();
    expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(false);
    expect(host.querySelector(".cm-editor")).toBe(view.dom);
  });

  it("keeps result-source decorations connected to public navigation methods", async () => {
    const { view, host, editor } = await mountEditor();
    editor.previewStatementRange({ from: 10, to: 19 });
    expect(view.state.selection.main.anchor).toBe(10);
    expect(host.querySelector(".cm-db-result-source-highlight")?.textContent).toBe("SELECT 2;");
    editor.previewStatementRange(null);
    expect(host.querySelector(".cm-db-result-source-highlight")).toBeNull();
    expect(view.state.doc.toString()).toBe("SELECT 1;\nSELECT 2;");
  });

  it("isolates extension reconfiguration and disposal between editor instances", async () => {
    const first = await mountEditor({ modelValue: "SELECT 1;", tabId: "independent-a" });
    const second = await mountEditor({ modelValue: "SELECT 2;", tabId: "independent-b" });
    first.props.forceWordWrap = true;
    await nextTick();
    expect(first.view.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
    expect(second.view.contentDOM.classList.contains("cm-lineWrapping")).toBe(false);
    first.unmount();
    second.view.dispatch({ changes: { from: 7, to: 8, insert: "3" } });
    expect(second.view.state.doc.toString()).toBe("SELECT 3;");
    expect(second.host.querySelectorAll(".cm-editor")).toHaveLength(1);
  });

  it("selects the CTE definition and renders its source range before focusing", async () => {
    const sql = "WITH picked AS (SELECT id FROM users) SELECT id FROM picked";
    const { view, host, connectionStore, onClickTable } = await mountEditor({ modelValue: sql, connectionId: "navigation-test", database: "demo", databaseType: "postgres", dialect: "postgres" });
    const originalFocus = view.focus.bind(view);
    let navigationSnapshot: { selection: string; highlightedSource: string | null | undefined } | undefined;
    const focus = vi.spyOn(view, "focus").mockImplementation(() => {
      navigationSnapshot = {
        selection: view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
        highlightedSource: host.querySelector(".cm-db-result-source-highlight")?.textContent,
      };
      originalFocus();
    });
    vi.spyOn(view, "posAtCoords").mockReturnValue(sql.lastIndexOf("picked") + 2);
    const lookupTables = vi.spyOn(connectionStore, "lookupLocalCompletionTables");
    view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { ctrlKey: true, button: 0, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(focus).toHaveBeenCalledOnce());
    expect(navigationSnapshot).toEqual({ selection: "picked", highlightedSource: "picked AS (SELECT id FROM users)" });
    expect(view.state.selection.main.from).toBe(sql.indexOf("picked"));
    expect(onClickTable).not.toHaveBeenCalled();
    expect(lookupTables).not.toHaveBeenCalled();
  });

  it("emits table navigation from the local cache without consuming Alt-modified gestures", async () => {
    const sql = "SELECT * FROM users";
    const { view, connectionStore, onClickTable } = await mountEditor({ modelValue: sql, connectionId: "navigation-test", database: "demo" });
    vi.spyOn(view, "posAtCoords").mockReturnValue(sql.indexOf("users") + 2);
    vi.spyOn(connectionStore, "lookupLocalCompletionTables").mockReturnValue([{ name: "users", schema: "demo" }]);
    view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { ctrlKey: true, altKey: true, button: 0, bubbles: true, cancelable: true }));
    await nextTick();
    expect(onClickTable).not.toHaveBeenCalled();
    view.dispatch({ selection: { anchor: 0 } });
    view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { ctrlKey: true, button: 0, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(onClickTable).toHaveBeenCalledWith(expect.objectContaining({ name: "users" })));
    expect(view.state.doc.toString()).toBe(sql);
  });

  it.each([false, true])("preserves selection drag edits with copy=%s through the real mouse handlers", async (copy) => {
    const { view, props } = await mountEditor({ modelValue: "abc def ghi" });
    view.dispatch({ selection: { anchor: 4, head: 7 } });
    const position = vi.spyOn(view, "posAtCoords").mockReturnValue(5);
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 50, right: 51, top: 20, bottom: 38 });
    view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { button: 0, detail: 1, clientX: 10, clientY: 10, ctrlKey: copy, bubbles: true, cancelable: true }));
    position.mockReturnValue(11);
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 30, clientY: 10, ctrlKey: copy, cancelable: true }));
    expect(document.querySelector(".dbx-editor-selection-drop-cursor")).not.toBeNull();
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 30, clientY: 10, ctrlKey: copy, cancelable: true }));
    await nextTick();
    expect(view.state.doc.toString()).toBe(copy ? "abc def ghidef" : "abc  ghidef");
    expect(props.modelValue).toBe(view.state.doc.toString());
    expect(document.querySelector(".dbx-editor-selection-drop-cursor")).toBeNull();
  });

  it.each(["native", "window"])("connects %s table-reference drops to document updates and caret cleanup", async (source) => {
    const { view, props, host } = await mountEditor({ modelValue: "SELECT old", databaseType: "postgres", dialect: "postgres" });
    const root = host.querySelector("[data-query-editor-root]") as HTMLElement;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 100));
    const position = vi.spyOn(view, "posAtCoords").mockReturnValue(7);
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 25, right: 26, top: 30, bottom: 48 });
    view.dispatch({ selection: { anchor: 7, head: 10 } });
    const payload: QueryEditorTableReferencePayload = { kind: "dbx-table-reference", connectionId: "drop-test", database: "demo", tableName: "users", referenceType: "column", columnName: "id" };
    setActiveTableReferencePayload(payload);
    window.dispatchEvent(createTableReferenceHoverEvent({ clientX: 30, clientY: 40 }));
    await nextTick();
    const caret = host.querySelector("[data-query-editor-drop-caret]") as HTMLElement;
    expect(caret.style.display).not.toBe("none");
    position.mockReturnValue(null);
    if (source === "native") view.contentDOM.dispatchEvent(new DragEvent("drop", { clientX: 30, clientY: 40, bubbles: true, cancelable: true }));
    else window.dispatchEvent(createTableReferenceDropEvent({ payload, clientX: 30, clientY: 40 }));
    await nextTick();
    expect(view.state.doc.toString()).toBe("SELECT id");
    expect(props.modelValue).toBe("SELECT id");
    expect(caret.style.display).toBe("none");
  });

  it("keeps readonly table drops inert and removes global drop listeners on unmount", async () => {
    const { view, host, props, unmount } = await mountEditor({ modelValue: "SELECT old", readOnly: true });
    const root = host.querySelector("[data-query-editor-root]") as HTMLElement;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 100));
    const position = vi.spyOn(view, "posAtCoords").mockReturnValue(10);
    const payload: QueryEditorTableReferencePayload = { kind: "dbx-table-reference", connectionId: "drop-test", database: "demo", tableName: "users", referenceType: "column", columnName: "id" };
    window.dispatchEvent(createTableReferenceDropEvent({ payload, clientX: 30, clientY: 40 }));
    expect(position).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("SELECT old");
    props.readOnly = false;
    await nextTick();
    unmount();
    position.mockClear();
    window.dispatchEvent(createTableReferenceDropEvent({ payload, clientX: 30, clientY: 40 }));
    expect(position).not.toHaveBeenCalled();
  });
});
