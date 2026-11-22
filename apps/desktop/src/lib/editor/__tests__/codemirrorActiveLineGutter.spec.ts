import { EditorSelection, EditorState } from "@codemirror/state";
import { gutterLineClass } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { highlightActiveCursorLineGutter } from "../codemirrorActiveLineGutter";

function activeLines(state: EditorState): number[] {
  const lines: number[] = [];
  for (const set of state.facet(gutterLineClass)) {
    const cursor = set.iter();
    for (; cursor.value; cursor.next()) lines.push(state.doc.lineAt(cursor.from).number);
  }
  return lines;
}

describe("highlightActiveCursorLineGutter", () => {
  const doc = "SELECT 1;\nSELECT 2;\nSELECT 3;";

  it("marks the cursor lines once each", () => {
    const state = EditorState.create({
      doc,
      selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(3), EditorSelection.cursor(22)]),
      extensions: [EditorState.allowMultipleSelections.of(true), highlightActiveCursorLineGutter()],
    });
    expect(activeLines(state)).toEqual([1, 3]);
  });

  it("marks nothing while the main selection is a range, so a drag never changes the gutter classes", () => {
    let state = EditorState.create({ doc, selection: { anchor: 0, head: 3 }, extensions: [highlightActiveCursorLineGutter()] });
    expect(activeLines(state)).toEqual([]);
    const before = state.facet(gutterLineClass);
    state = state.update({ selection: { anchor: 0, head: 25 } }).state;
    expect(activeLines(state)).toEqual([]);
    expect(state.facet(gutterLineClass)[0].size).toBe(before[0].size);
  });
});
