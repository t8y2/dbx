import { EditorState, StateEffect, StateField, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createQueryEditorLastEditLocations, LAST_EDIT_LOCATION_LIMIT } from "@/lib/editor/codemirrorLastEditLocation";

function createEditor(doc: string, cursor = 0) {
  const runtime = createQueryEditorLastEditLocations({ modules: { StateField, StateEffect } });
  let state = EditorState.create({ doc, selection: { anchor: cursor }, extensions: [runtime.extension] });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
  } as unknown as EditorView;
  return {
    runtime,
    view,
    get state() {
      return state;
    },
    positions: () => state.field(runtime.field).positions,
    cursor: () => state.field(runtime.field).cursor,
    select(position: number) {
      state = state.update({ selection: { anchor: position } }).state;
    },
    type(text: string) {
      const head = state.selection.main.head;
      state = state.update({
        changes: { from: head, insert: text },
        selection: { anchor: head + text.length },
        userEvent: "input.type",
      }).state;
    },
  };
}

describe("query editor last edit locations", () => {
  it("records the cursor position the edit started from", () => {
    const editor = createEditor("select 1\nselect 2\nselect 3");
    editor.select(9);
    editor.type("x");
    expect(editor.positions()).toEqual([9]);
    expect(editor.cursor()).toBe(0);
  });

  it("coalesces consecutive edits on the same line into one entry", () => {
    const editor = createEditor("select 1\nselect 2\nselect 3");
    editor.select(9);
    editor.type("a");
    editor.type("b");
    editor.type("c");
    expect(editor.positions()).toEqual([9]);
  });

  it("pushes a new entry once the edit moves to another line", () => {
    const editor = createEditor("select 1\nselect 2\nselect 3");
    editor.select(9);
    editor.type("x");
    editor.select(19);
    editor.type("y");
    expect(editor.positions()).toEqual([19, 9]);
  });

  it("maps stored positions through later edits", () => {
    const editor = createEditor("select 1\nselect 2\nselect 3");
    editor.select(19);
    editor.type("y");
    editor.select(9);
    editor.type("x");
    // The earlier edit kept its own offset; the entry recorded before it moved
    // one character right because the new text landed in front of it.
    expect(editor.positions()).toEqual([9, 20]);
    editor.select(0);
    editor.type("-- head\n");
    expect(editor.positions()).toEqual([0, 17, 28]);
  });

  it("ignores selection-only transactions", () => {
    const editor = createEditor("select 1\nselect 2");
    editor.select(9);
    editor.type("x");
    editor.select(0);
    expect(editor.positions()).toEqual([9]);
  });

  it("maps without recording when the edit comes from undo or redo", () => {
    const editor = createEditor("select 1\nselect 2");
    editor.select(9);
    editor.type("x");
    editor.view.dispatch({ changes: { from: 0, insert: "--" }, userEvent: "undo" });
    expect(editor.positions()).toEqual([11]);
  });

  it("restarts the stack when the whole document is replaced", () => {
    const editor = createEditor("select 1\nselect 2");
    editor.select(9);
    editor.type("x");
    editor.view.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: "select 3\nselect 4" }, userEvent: "input.paste" });
    expect(editor.positions()).toEqual([]);
  });

  it("bounds the stack to the configured limit", () => {
    const lines = Array.from({ length: LAST_EDIT_LOCATION_LIMIT + 8 }, (_, index) => `select ${index}`).join("\n");
    const editor = createEditor(lines);
    let offset = 0;
    for (let index = 0; index < LAST_EDIT_LOCATION_LIMIT + 8; index += 1) {
      editor.select(offset);
      editor.type("x");
      offset = editor.state.doc.lineAt(editor.state.selection.main.head).to + 1;
    }
    expect(editor.positions()).toHaveLength(LAST_EDIT_LOCATION_LIMIT);
  });

  it("jumps back to older entries and wraps around", () => {
    const editor = createEditor("select 1\nselect 2\nselect 3");
    editor.select(9);
    editor.type("x");
    editor.select(19);
    editor.type("y");
    expect(editor.runtime.goBack(editor.view)).toBe(true);
    expect(editor.state.selection.main.head).toBe(19);
    expect(editor.runtime.goBack(editor.view)).toBe(true);
    expect(editor.state.selection.main.head).toBe(9);
    expect(editor.runtime.goBack(editor.view)).toBe(true);
    expect(editor.state.selection.main.head).toBe(19);
    expect(editor.positions()).toEqual([19, 9]);
  });

  it("restarts navigation from the newest entry after a new edit", () => {
    const editor = createEditor("select 1\nselect 2\nselect 3");
    editor.select(19);
    editor.type("y");
    editor.select(0);
    editor.type("-");
    expect(editor.positions()).toEqual([0, 20]);
    editor.runtime.goBack(editor.view);
    expect(editor.cursor()).toBe(1);
    editor.select(11);
    editor.type("z");
    expect(editor.cursor()).toBe(0);
    expect(editor.positions()).toEqual([11, 0, 21]);
  });

  it("reports no jump when the stack is empty and supports an explicit reset", () => {
    const editor = createEditor("select 1\nselect 2");
    expect(editor.runtime.goBack(editor.view)).toBe(false);
    editor.select(9);
    editor.type("x");
    editor.runtime.reset(editor.view);
    expect(editor.positions()).toEqual([]);
    expect(editor.runtime.goBack(editor.view)).toBe(false);
  });
});
