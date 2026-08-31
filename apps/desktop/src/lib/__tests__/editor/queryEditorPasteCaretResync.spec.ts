import { readFileSync } from "node:fs";
import { EditorSelection } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { computePasteCaretResyncTarget } from "@/lib/editor/queryEditorPasteCaretResync";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

describe("computePasteCaretResyncTarget", () => {
  it("nudges a single caret forward when there is room", () => {
    expect(computePasteCaretResyncTarget(EditorSelection.single(3), 10)).toBe(4);
  });

  it("nudges a single caret backward at the end of the document", () => {
    expect(computePasteCaretResyncTarget(EditorSelection.single(10), 10)).toBe(9);
  });

  it("does not collapse multiple CodeMirror cursors", () => {
    const selection = EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(6)]);
    expect(computePasteCaretResyncTarget(selection, 10)).toBeNull();
  });

  it("does not replace a non-empty selection with a caret", () => {
    expect(computePasteCaretResyncTarget(EditorSelection.single(2, 5), 10)).toBeNull();
  });

  it("returns null for an empty document", () => {
    expect(computePasteCaretResyncTarget(EditorSelection.single(0), 0)).toBeNull();
  });
});

describe("QueryEditor paste caret resync wiring", () => {
  it("resyncs only an unchanged single caret after an input.paste transaction", () => {
    expect(queryEditorSource).toMatch(/update\.transactions\.some\(\(tr\) => tr\.isUserEvent\("input\.paste"\)\)[\s\S]*?resyncCaretAfterPaste\(update\.view\)/);
    expect(queryEditorSource).toMatch(/computePasteCaretResyncTarget\(selection, view\.state\.doc\.length\)/);
  });
});
