import { EditorSelection, type EditorState, type SelectionRange } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** Return one cursor at the end of every document line touched by a selection. */
export function selectionLineEndCursors(state: EditorState, ranges: readonly SelectionRange[] = state.selection.ranges): EditorSelection {
  const positions = new Set<number>();
  for (const range of ranges) {
    const fromLine = state.doc.lineAt(range.from);
    const toLine = state.doc.lineAt(range.to);
    for (let number = fromLine.number; number <= toLine.number; number++) {
      positions.add(state.doc.line(number).to);
    }
  }
  const cursors = [...positions].sort((a, b) => a - b).map((position) => EditorSelection.cursor(position));
  return EditorSelection.create(cursors.length ? cursors : [EditorSelection.cursor(0)]);
}

/** Place cursors at the ends of all lines touched by the current selection. */
export function selectLineEnds(view: EditorView): boolean {
  view.dispatch({ selection: selectionLineEndCursors(view.state), userEvent: "select.lineEnds" });
  return true;
}
