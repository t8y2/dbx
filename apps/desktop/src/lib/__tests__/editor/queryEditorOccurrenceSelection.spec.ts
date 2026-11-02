// @vitest-environment happy-dom

import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { addNextQueryEditorSelectionOccurrence, selectAllQueryEditorSelectionOccurrences } from "@/lib/editor/queryEditorOccurrenceSelection";

function createView(doc: string, selection: EditorSelection) {
  return new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({
      doc,
      selection,
      extensions: [EditorState.allowMultipleSelections.of(true)],
    }),
  });
}

function ranges(view: EditorView) {
  return view.state.selection.ranges.map(({ from, to }) => ({ from, to }));
}

describe("queryEditorOccurrenceSelection", () => {
  it("adds the next occurrence of the current selection", () => {
    const view = createView("foo bar foo baz foo", EditorSelection.single(0, 3));

    expect(addNextQueryEditorSelectionOccurrence(view)).toBe(true);

    expect(ranges(view)).toEqual([
      { from: 0, to: 3 },
      { from: 8, to: 11 },
    ]);
  });

  it("expands an empty cursor to the current word before adding the next occurrence", () => {
    const view = createView("select id from users where id = 1", EditorSelection.cursor(8));

    expect(addNextQueryEditorSelectionOccurrence(view)).toBe(true);

    expect(ranges(view)).toEqual([
      { from: 7, to: 9 },
      { from: 27, to: 29 },
    ]);
  });

  it("word-expands every empty range when multiple cursors are active", () => {
    // One cursor sits on a word, the second (Alt+click) is empty on another
    // word: the single-cursor helper cannot run, so the native command
    // word-expands every empty range and adds the next occurrence.
    const view = createView("foo bar foo", EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.cursor(4)]));

    expect(addNextQueryEditorSelectionOccurrence(view)).toBe(true);

    // "bar" has no further occurrence, so the selection stays at the two
    // word ranges — the point is the empty cursor was expanded, not dropped.
    expect(ranges(view)).toEqual([
      { from: 0, to: 3 },
      { from: 4, to: 7 },
    ]);
  });

  it("selects every occurrence of the selected text", () => {
    const view = createView("foo bar foo baz foo", EditorSelection.single(0, 3));

    expect(selectAllQueryEditorSelectionOccurrences(view)).toBe(true);

    expect(ranges(view)).toEqual([
      { from: 0, to: 3 },
      { from: 8, to: 11 },
      { from: 16, to: 19 },
    ]);
  });

  it("selects every occurrence after the next occurrence was already added", () => {
    const view = createView("foo bar foo baz foo", EditorSelection.single(0, 3));

    expect(addNextQueryEditorSelectionOccurrence(view)).toBe(true);
    expect(selectAllQueryEditorSelectionOccurrences(view)).toBe(true);

    expect(ranges(view)).toEqual([
      { from: 0, to: 3 },
      { from: 8, to: 11 },
      { from: 16, to: 19 },
    ]);
  });

  it("selects all occurrences of the word around an empty cursor", () => {
    const view = createView("select id from users where id = 1", EditorSelection.cursor(8));

    expect(selectAllQueryEditorSelectionOccurrences(view)).toBe(true);

    expect(ranges(view)).toEqual([
      { from: 7, to: 9 },
      { from: 27, to: 29 },
    ]);
  });
});
