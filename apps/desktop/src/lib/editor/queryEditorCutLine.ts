import type { Command } from "@codemirror/view";
import { copyToClipboard } from "@/lib/common/clipboard";

/**
 * Shift+Delete / Ctrl+X with an empty selection cuts the whole line. CodeMirror
 * implements that as "line text plus the break after it", but a document
 * cannot end in a break, so on the last line the range degenerates to the line
 * itself: an empty trailing line survives untouched, and a non-empty last line
 * leaves an empty one behind that the same shortcut then cannot remove. Take
 * the cut over for cursors on the last line and eat the break *before* the
 * line instead — the same join CodeMirror's deleteLine command performs.
 * Everything else returns false so the native cut keeps handling it, which
 * also keeps CodeMirror's line-wise paste marker intact for mid-document cuts.
 */
export const cutQueryEditorLine: Command = (view) => {
  const { state } = view;
  if (state.readOnly || state.doc.lines === 1) return false;
  if (state.selection.ranges.some((range) => !range.empty)) return false;

  const lastLine = state.doc.line(state.doc.lines);
  if (!state.selection.ranges.some((range) => state.doc.lineAt(range.from).to === lastLine.to)) return false;

  const seen = new Set<number>();
  const lines: string[] = [];
  const changes: { from: number; to: number }[] = [];
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.from);
    if (!seen.add(line.number)) continue;
    lines.push(line.text);
    if (line.to < state.doc.length) changes.push({ from: line.from, to: line.to + 1 });
    else if (line.from > 0) changes.push({ from: line.from - 1, to: line.to });
    else changes.push({ from: line.from, to: line.to });
  }
  if (changes.length === 0) return false;

  void copyToClipboard(lines.join(state.lineBreak)).catch(() => {
    // The line is removed even when the clipboard refuses the write.
  });
  view.dispatch(state.update({ changes, scrollIntoView: true, userEvent: "delete.cut" }));
  return true;
};
