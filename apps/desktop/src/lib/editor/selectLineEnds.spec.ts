import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { selectionLineEndCursors } from "./selectLineEnds";

describe("selectionLineEndCursors", () => {
  it("selects the end of every touched line", () => {
    const state = EditorState.create({ doc: "one\ntwo\nthree" });
    const selection = EditorSelection.single(1, 9);
    const result = selectionLineEndCursors(state, selection.ranges);
    expect(result.ranges.map((range) => range.head)).toEqual([3, 7, 13]);
  });

  it("uses the current line for an empty selection", () => {
    const state = EditorState.create({ doc: "one\ntwo\nthree" });
    const result = selectionLineEndCursors(state, [EditorSelection.cursor(5)]);
    expect(result.ranges.map((range) => range.head)).toEqual([7]);
  });

  it("deduplicates lines covered by multiple ranges", () => {
    const state = EditorState.create({ doc: "one\ntwo\nthree" });
    const selection = EditorSelection.create([EditorSelection.range(0, 5), EditorSelection.range(4, 9)]);
    const result = selectionLineEndCursors(state, selection.ranges);
    expect(result.ranges.map((range) => range.head)).toEqual([3, 7, 13]);
  });

  it("handles an empty document", () => {
    const state = EditorState.create({ doc: "" });
    const result = selectionLineEndCursors(state);
    expect(result.ranges.map((range) => range.head)).toEqual([0]);
  });
});
