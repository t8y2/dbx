// @vitest-environment happy-dom

import { computed, createApp, h, reactive, shallowRef } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo, toggleLineComment, toggleBlockComment } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useQueryEditorTextActions } from "../useQueryEditorTextActions";
import { useSettingsStore } from "@/stores/settingsStore";
import type { QueryEditorProps } from "../queryEditorTypes";

const clipboard = vi.hoisted(() => ({ copyToClipboard: vi.fn(), readTextFromClipboard: vi.fn(), copySqlAsRichText: vi.fn() }));
vi.mock("@/lib/common/clipboard", () => clipboard);
vi.mock("@/lib/sql/sqlRichText", () => ({ copySqlAsRichText: clipboard.copySqlAsRichText }));
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.resetAllMocks();
});

function mountActions(text = "alice\nbob") {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  const host = document.createElement("div");
  const editorHost = document.createElement("div");
  document.body.append(host, editorHost);
  const props = reactive<QueryEditorProps>({ modelValue: text, databaseType: "mysql", dialect: "mysql" });
  const state = shallowRef(EditorState.create({ doc: text, selection: { anchor: 0, head: text.length }, extensions: [sql(), history(), EditorState.allowMultipleSelections.of(true)] }));
  const editorView = new EditorView({
    state: state.value,
    parent: editorHost,
    dispatchTransactions: (transactions, currentView) => {
      currentView.update(transactions);
      state.value = currentView.state;
    },
  });
  vi.spyOn(editorView, "focus").mockImplementation(() => {});
  const view = shallowRef<EditorView | null>(editorView);
  const selectedSql = computed(() => state.value.sliceDoc(state.value.selection.main.from, state.value.selection.main.to));
  let actions!: ReturnType<typeof useQueryEditorTextActions>;
  const app = createApp({
    setup() {
      actions = useQueryEditorTextActions({ props, view, selectedSql, settingsStore, sqlBehaviorDialect: () => props.dialect, focusEditor: () => view.value?.focus(), getEditorSelection: () => EditorSelection, toggleLineComment, toggleBlockComment });
      return () => h("div");
    },
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    editorView.destroy();
    host.remove();
    editorHost.remove();
  });
  return { actions, view, editorView, props };
}

describe("QueryEditor extracted text actions", () => {
  it("captures the delimited-list input and replaces the selection with one undoable edit", () => {
    const { actions, editorView } = mountActions();
    actions.openDelimitedListDialog();
    expect(actions.delimitedListOpen.value).toBe(true);
    expect(actions.delimitedListSelectedText.value).toBe("alice\nbob");
    actions.applyDelimitedListResult("'alice','bob'");
    expect(editorView.state.doc.toString()).toBe("'alice','bob'");
    expect(undo(editorView)).toBe(true);
    expect(editorView.state.doc.toString()).toBe("alice\nbob");
  });

  it("guards delimited-list opening and confirmation with the current read-only state", () => {
    const { actions, editorView, props } = mountActions();
    props.readOnly = true;
    actions.openDelimitedListDialog();
    expect(actions.delimitedListOpen.value).toBe(false);
    props.readOnly = false;
    actions.openDelimitedListDialog();
    props.readOnly = true;
    actions.applyDelimitedListResult("changed");
    expect(editorView.state.doc.toString()).toBe("alice\nbob");
  });

  it("does not open selection dialogs for whitespace-only input", () => {
    const { actions } = mountActions(" \n ");
    actions.openDelimitedListDialog();
    actions.openCodeSnapshot();
    expect(actions.delimitedListOpen.value).toBe(false);
    expect(actions.codeSnapshotOpen.value).toBe(false);
  });

  it("captures the code snapshot without aliasing later selections", () => {
    const { actions, editorView } = mountActions("SELECT 1");
    actions.openCodeSnapshot();
    editorView.dispatch({ selection: { anchor: 0 } });
    expect(actions.codeSnapshotOpen.value).toBe(true);
    expect(actions.codeSnapshotSource.value).toEqual({ code: "SELECT 1", lang: "sql" });
  });

  it("preserves plain and rich-text copying and undoable cutting", async () => {
    const { actions, editorView } = mountActions("SELECT 1");
    await actions.copySelectedSqlFromContextMenu();
    await actions.copySelectedSqlAsRichTextFromContextMenu();
    expect(clipboard.copyToClipboard).toHaveBeenCalledWith("SELECT 1");
    expect(clipboard.copySqlAsRichText).toHaveBeenCalledWith("SELECT 1");
    await actions.cutSelectedSqlFromContextMenu();
    expect(editorView.state.doc.toString()).toBe("");
    expect(undo(editorView)).toBe(true);
    expect(editorView.state.doc.toString()).toBe("SELECT 1");
  });

  it("does not cut the selection when clipboard writing fails", async () => {
    clipboard.copyToClipboard.mockRejectedValue(new Error("clipboard unavailable"));
    const { actions, editorView } = mountActions();
    await actions.cutSelectedSqlFromContextMenu();
    expect(editorView.state.doc.toString()).toBe("alice\nbob");
  });

  it("keeps clipboard normalization, caret placement, undo and read-only guards", async () => {
    clipboard.readTextFromClipboard.mockResolvedValue("one\r\ntwo");
    const { actions, editorView, props } = mountActions();
    await actions.pasteClipboardSqlFromContextMenu();
    expect(editorView.state.doc.toString()).toBe("one\ntwo");
    expect(editorView.state.selection.main.head).toBe(7);
    expect(undo(editorView)).toBe(true);
    expect(editorView.state.doc.toString()).toBe("alice\nbob");
    props.readOnly = true;
    await actions.pasteClipboardSqlFromContextMenu();
    expect(clipboard.readTextFromClipboard).toHaveBeenCalledTimes(1);
  });

  it("preserves multi-range case conversion and selects each replacement", () => {
    const { actions, editorView } = mountActions("select id, name from users");
    editorView.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, 6), EditorSelection.range(16, 20)]) });
    expect(actions.convertSelectedSqlCase("upper")).toBe(true);
    expect(editorView.state.doc.toString()).toBe("SELECT id, name FROM users");
    expect(editorView.state.selection.ranges.map((range) => editorView.state.sliceDoc(range.from, range.to))).toEqual(["SELECT", "FROM"]);
    expect(undo(editorView)).toBe(true);
    expect(editorView.state.doc.toString()).toBe("select id, name from users");
  });

  it("preserves naming conversion and an undoable empty-line deletion", () => {
    const { actions, editorView } = mountActions("user_name");
    expect(actions.convertSelectedNamingStyle()).toBe(true);
    expect(editorView.state.doc.toString()).toBe("USER_NAME");
    editorView.setState(EditorState.create({ doc: "SELECT 1;\n\nSELECT 2;", extensions: [history()] }));
    actions.deleteEmptyLines();
    expect(editorView.state.doc.toString()).toBe("SELECT 1;\nSELECT 2;");
    expect(undo(editorView)).toBe(true);
    expect(editorView.state.doc.toString()).toBe("SELECT 1;\n\nSELECT 2;");
  });

  it("does not apply a pending IN-list paste after the view or read-only state changes", async () => {
    let resolveClipboard!: (text: string) => void;
    clipboard.readTextFromClipboard.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveClipboard = resolve;
      }),
    );
    const { actions, editorView, props } = mountActions("");
    const pending = actions.pasteClipboardAsSqlInCondition();
    props.readOnly = true;
    resolveClipboard("alice\nbob");
    expect(await pending).toBe(false);
    expect(editorView.state.doc.toString()).toBe("");
  });

  it("tolerates missing views and empty selections without dispatching", async () => {
    const { actions, view } = mountActions("");
    view.value = null;
    expect(actions.convertSelectedSqlCase("upper")).toBe(false);
    expect(actions.convertSelectedNamingStyle()).toBe(false);
    expect(await actions.pasteClipboardAsSqlInCondition()).toBe(false);
    expect(() => {
      actions.applyDelimitedListResult("text");
      actions.deleteEmptyLines();
      actions.selectAllSqlFromContextMenu();
    }).not.toThrow();
  });
});
