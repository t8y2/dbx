import { normalizeQueryEditorPasteText } from "./queryEditorLargePaste";

export interface QueryEditorPasteChange {
  changes: { from: number; to: number; insert: string };
  selection: { anchor: number; head: number };
}

/**
 * Build the "replace [from, to) with clipboard text" transaction for the query editor.
 *
 * CodeMirror normalizes the line endings of inserted text (`\r\n` and `\r` become `\n`), so a
 * caret derived from the raw clipboard length overshoots the new document whenever the clipboard
 * holds CRLF text (Excel rows, Windows editors) and `dispatch` throws
 * `RangeError: Selection points outside of document` -- it only survives while the replaced
 * selection leaves at least that many characters behind it. Deriving the caret from the text
 * that actually lands in the document keeps the paste working for any selection.
 */
export function queryEditorClipboardPasteChange(rawText: string, from: number, to: number): QueryEditorPasteChange {
  const insert = normalizeQueryEditorPasteText(rawText);
  const caret = from + insert.length;
  return { changes: { from, to, insert }, selection: { anchor: caret, head: caret } };
}
