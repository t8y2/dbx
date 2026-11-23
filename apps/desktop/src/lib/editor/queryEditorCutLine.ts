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

  const lines: string[] = [];
  const changes: { from: number; to: number }[] = [];
  let lastCutLine = 0;
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.from);
    if (lastCutLine === line.number) continue;
    lines.push(line.text);
    const reachesEnd = line.number === lastLine.number;
    const to = reachesEnd ? line.to : line.to + 1;
    const previous = changes[changes.length - 1];
    if (previous && lastCutLine === line.number - 1) {
      if (reachesEnd) previous.from = Math.max(0, previous.from - 1);
      previous.to = to;
    } else {
      changes.push({ from: reachesEnd ? line.from - 1 : line.from, to });
    }
    lastCutLine = line.number;
  }

  void copyToClipboard(lines.join(state.lineBreak)).then(
    () => {
      if (view.state !== state) return;
      view.dispatch(state.update({ changes, scrollIntoView: true, userEvent: "delete.cut" }));
    },
    () => {
      // A cut must leave the text in the document if the clipboard cannot store it.
    },
  );
  return true;
};
