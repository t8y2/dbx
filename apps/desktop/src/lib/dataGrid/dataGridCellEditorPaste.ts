// Multiline paste handling for the data grid inline cell editor (#15307).
//
// The inline editor for a plain text cell is a single-line <input>: a native
// paste into it makes the browser flatten every "\n"/"\r" into a space, so
// multi-line clipboard text silently loses its line breaks. These helpers let
// the grid detect that case and hand the paste to the expanded <textarea>
// editor of the same cell, which preserves line breaks.

export function inlineCellEditorPasteNeedsExpandedEditor(text: string): boolean {
  return text.includes("\n") || text.includes("\r");
}

export interface InlineCellEditorPasteApplication {
  /** Editor value after the paste has been applied. */
  value: string;
  /** Caret position after the pasted text. */
  caret: number;
}

export function applyInlineCellEditorPaste(value: string, selectionStart: number | null, selectionEnd: number | null, pasteText: string): InlineCellEditorPasteApplication {
  const start = clampCaret(selectionStart ?? value.length, value.length);
  const end = clampCaret(selectionEnd ?? start, value.length);
  const boundedStart = Math.min(start, end);
  const boundedEnd = Math.max(start, end);
  return {
    value: value.slice(0, boundedStart) + pasteText + value.slice(boundedEnd),
    caret: boundedStart + pasteText.length,
  };
}

function clampCaret(position: number, length: number): number {
  return Math.max(0, Math.min(position, length));
}
