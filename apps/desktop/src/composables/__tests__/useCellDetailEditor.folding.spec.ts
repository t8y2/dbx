import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { json } from "@codemirror/lang-json";
import { foldable } from "@codemirror/language";

describe("Redis JSON editor folding", () => {
  it("provides foldable ranges for JSON objects and arrays", () => {
    const state = EditorState.create({
      doc: `{
  "items": [
    1,
    2
  ]
}`,
      extensions: [json()],
    });

    const objectLine = state.doc.line(1);
    const arrayLine = state.doc.line(2);
    const arrayCloseLine = state.doc.line(5);

    expect(foldable(state, objectLine.from, objectLine.to)).toEqual({ from: objectLine.to, to: state.doc.line(6).from });
    expect(foldable(state, arrayLine.from, arrayLine.to)).toEqual({ from: arrayLine.to, to: arrayCloseLine.from + arrayCloseLine.text.indexOf("]") });
  });
});
