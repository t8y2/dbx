import { readFileSync } from "node:fs";
import { toggleBlockComment } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

function runToggleBlockComment(doc: string, selection: EditorSelection | { anchor: number; head?: number }) {
  let state = EditorState.create({ doc, selection, extensions: [sql()] });
  const dispatch = vi.fn((transaction: Transaction) => {
    state = transaction.state;
  });
  const handled = toggleBlockComment({
    get state() {
      return state;
    },
    dispatch,
  } as never);

  return { dispatch, handled, state };
}

describe("QueryEditor block comment", () => {
  it("wires toggleBlockComment into the right-click context menu, the keymap, and the editor module load", () => {
    expect(queryEditorSource).toContain('let codeMirrorToggleBlockComment: typeof import("@codemirror/commands").toggleBlockComment | null = null;');
    expect(queryEditorSource).toContain("codeMirrorToggleBlockComment?.(currentView);");
    expect(queryEditorSource).toContain('label: t("editor.contextMenu.blockCommentSelection")');
    expect(queryEditorSource).toContain("shortcut: shortcuts.toggleBlockComment");
    expect(queryEditorSource).toContain("...binding(shortcuts.toggleBlockComment, (view) => {");
    expect(queryEditorSource).toContain("!supportsQueryEditorBlockComments(props.databaseType)");
    expect(queryEditorSource).toContain("defaultKeymapForGlobalShortcuts(codeMirrorDefaultKeymap, settingsStore.editorSettings.shortcuts).filter((item) => item.run !== codeMirrorToggleBlockComment)");
    expect(queryEditorSource).toContain("defaultKeymapComp.reconfigure(defaultKeymapExtension())");
    expect(queryEditorSource).toContain("codeMirrorToggleBlockComment = toggleBlockComment;");
  });

  it("wraps the selected SQL in a block comment", () => {
    const doc = "SELECT id FROM users;";
    const selection = EditorSelection.range(doc.indexOf("id"), doc.indexOf("id") + "id".length);
    const result = runToggleBlockComment(doc, selection);

    expect(result.handled).toBe(true);
    expect(result.state.doc.toString()).toBe("SELECT /* id */ FROM users;");
  });

  it("removes an existing block comment around the selection", () => {
    const doc = "SELECT /* id */ FROM users;";
    const selection = EditorSelection.range(doc.indexOf("/*"), doc.indexOf("*/") + "*/".length);
    const result = runToggleBlockComment(doc, selection);

    expect(result.state.doc.toString()).toBe("SELECT id FROM users;");
  });
});
