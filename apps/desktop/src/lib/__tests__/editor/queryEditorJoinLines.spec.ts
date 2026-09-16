import { readFileSync } from "node:fs";
import { EditorSelection, EditorState, type Extension, type Transaction } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { joinQueryEditorLines } from "@/lib/editor/queryEditorJoinLines";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

function runJoinLines(doc: string, selection: EditorSelection | { anchor: number; head?: number }, extensions: Extension[] = []) {
  let state = EditorState.create({ doc, selection, extensions });
  const dispatch = vi.fn((transaction: Transaction) => {
    state = transaction.state;
  });
  const handled = joinQueryEditorLines({
    get state() {
      return state;
    },
    dispatch,
  } as never);

  return { dispatch, handled, state };
}

describe("joinQueryEditorLines", () => {
  it("binds the configurable join-lines shortcut in QueryEditor", () => {
    expect(queryEditorSource).toContain('import { joinQueryEditorLines } from "@/lib/editor/queryEditorJoinLines";');
    expect(queryEditorSource).toContain("...binding(shortcuts.joinLines, joinQueryEditorLines)");
  });

  it("joins every selected line with one separating space", () => {
    const doc = "SELECT id,\n       name\nFROM users;";
    const result = runJoinLines(doc, EditorSelection.range(0, doc.length));

    expect(result.handled).toBe(true);
    expect(result.state.doc.toString()).toBe("SELECT id, name FROM users;");
    expect(result.state.selection.main.from).toBe(0);
    expect(result.state.selection.main.to).toBe(result.state.doc.length);
  });

  it("joins only the lines touched by the selection", () => {
    const doc = "SELECT\n  id,\n  name\nFROM users;";
    const selection = EditorSelection.range(doc.indexOf("id"), doc.indexOf("name") + "name".length);
    const result = runJoinLines(doc, selection);

    expect(result.state.doc.toString()).toBe("SELECT\n  id, name\nFROM users;");
    expect(result.state.sliceDoc(result.state.selection.main.from, result.state.selection.main.to)).toBe("id, name");
  });

  it("joins the current line with the next line when the selection is empty", () => {
    const doc = "SELECT id,\n  name";
    const cursor = doc.indexOf("id");
    const result = runJoinLines(doc, { anchor: cursor });

    expect(result.state.doc.toString()).toBe("SELECT id, name");
    expect(result.state.selection.main.anchor).toBe(cursor);
  });

  it("collapses blank lines and surrounding whitespace", () => {
    const doc = "SELECT id,   \n\n       name";
    const result = runJoinLines(doc, EditorSelection.range(0, doc.length));

    expect(result.state.doc.toString()).toBe("SELECT id, name");
  });

  it("joins independent line pairs for multiple cursors", () => {
    const doc = "a\n  b\nc\n  d";
    const selection = EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(doc.indexOf("c"))]);
    const result = runJoinLines(doc, selection, [EditorState.allowMultipleSelections.of(true)]);

    expect(result.state.doc.toString()).toBe("a b\nc d");
    expect(result.state.selection.ranges).toHaveLength(2);
  });

  it("does not edit read-only documents", () => {
    const doc = "SELECT id,\n  name";
    const result = runJoinLines(doc, { anchor: 0 }, [EditorState.readOnly.of(true)]);

    expect(result.handled).toBe(false);
    expect(result.dispatch).not.toHaveBeenCalled();
    expect(result.state.doc.toString()).toBe(doc);
  });

  it("returns false when there is no following or selected line to join", () => {
    const result = runJoinLines("SELECT 1;", { anchor: 0 });

    expect(result.handled).toBe(false);
    expect(result.dispatch).not.toHaveBeenCalled();
  });
});
