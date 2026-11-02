import { strict as assert } from "node:assert";
import { test } from "vitest";
import { EditorState } from "@codemirror/state";
import { queryEditorClipboardPasteChange } from "@/lib/editor/queryEditorClipboardPaste";

const EXCEL_ROWS = "1\tA\r\n2\tB\r\n3\tC";

test("caret lands at the end of the normalized paste text", () => {
  const change = queryEditorClipboardPasteChange(EXCEL_ROWS, 10, 20);
  assert.equal(change.changes.insert, "1\tA\n2\tB\n3\tC");
  assert.equal(change.changes.from, 10);
  assert.equal(change.changes.to, 20);
  assert.deepEqual(change.selection, { anchor: 10 + change.changes.insert.length, head: 10 + change.changes.insert.length });
});

test("pasting CRLF text over a selection that reaches the end of the document keeps the caret in range", () => {
  const doc = "SELECT 1;\n".repeat(120);
  const state = EditorState.create({ doc });
  const transaction = state.update({
    ...queryEditorClipboardPasteChange(EXCEL_ROWS, 0, state.doc.length),
    scrollIntoView: true,
    userEvent: "input.paste",
  });
  assert.equal(transaction.state.doc.toString(), "1\tA\n2\tB\n3\tC");
  assert.equal(transaction.state.selection.main.anchor, transaction.state.doc.length);
});

test("raw clipboard length would overshoot the document (the reported RangeError)", () => {
  const doc = "SELECT 1;\n".repeat(120);
  const state = EditorState.create({ doc });
  assert.throws(
    () =>
      state.update({
        changes: { from: 0, to: state.doc.length, insert: EXCEL_ROWS },
        selection: { anchor: EXCEL_ROWS.length },
        userEvent: "input.paste",
      }),
    /Selection points outside of document/,
  );
});

test("LF clipboard text keeps the same caret as before", () => {
  const change = queryEditorClipboardPasteChange("a\nb", 3, 3);
  assert.deepEqual(change.changes, { from: 3, to: 3, insert: "a\nb" });
  assert.deepEqual(change.selection, { anchor: 6, head: 6 });
});
