import type { Transaction, TransactionSpec } from "@codemirror/state";
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

// Keep a pasted query runnable when the clipboard ends in blank lines, without
// removing whitespace that may be meaningful to the user's next edit.
export function keepQueryEditorPasteCaretOnLastContentLine(transaction: Transaction): TransactionSpec | readonly TransactionSpec[] {
  if (!transaction.docChanged || !transaction.isUserEvent("input.paste")) return transaction;
  if (transaction.startState.selection.ranges.length !== 1 || transaction.newSelection.ranges.length !== 1) return transaction;
  const selection = transaction.newSelection.main;
  if (!selection.empty || selection.head !== transaction.changes.newLength) return transaction;

  const previousDoc = transaction.startState.doc;
  let anchor: number | undefined;
  transaction.changes.iterChanges((from, to, insertedFrom, insertedTo, inserted) => {
    if (to !== previousDoc.length || insertedTo !== selection.head || inserted.lines < 2) return;
    if (previousDoc.sliceString(previousDoc.lineAt(from).from, from).trim()) return;
    const text = inserted.toString();
    const trimmedLength = text.trimEnd().length;
    if (trimmedLength && text.indexOf("\n", trimmedLength) >= 0) anchor = insertedFrom + trimmedLength;
  });

  return anchor === undefined ? transaction : [transaction, { selection: { anchor }, sequential: true }];
}
