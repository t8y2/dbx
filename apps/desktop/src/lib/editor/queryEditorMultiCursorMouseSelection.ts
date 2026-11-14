import { EditorSelection } from "@codemirror/state";
import type { EditorView, MouseSelectionStyle } from "@codemirror/view";

/** Alt+Ctrl/Cmd selects independent ranges, even when Shift is held. */
export function createQueryEditorMultiCursorMouseSelection(view: EditorView, event: MouseEvent): MouseSelectionStyle | null {
  if (event.button !== 0 || !event.altKey || !(event.ctrlKey || event.metaKey) || event.detail > 2) return null;
  const wordSelection = event.detail === 2;
  let start = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false);
  let selection = view.state.selection;
  const rangeAt = (pos: number) => (wordSelection ? view.state.wordAt(pos) : null) ?? EditorSelection.cursor(pos);

  return {
    update(update) {
      if (!update.docChanged) return;
      start = { pos: update.changes.mapPos(start.pos, start.assoc), assoc: start.assoc };
      selection = selection.map(update.changes);
    },
    get(currentEvent) {
      const current = view.posAndSideAtCoords({ x: currentEvent.clientX, y: currentEvent.clientY }, false);
      if (!wordSelection && start.pos === current.pos && selection.ranges.length > 1) {
        const index = selection.ranges.findIndex((range) => range.from <= current.pos && range.to >= current.pos);
        if (index >= 0) {
          const ranges = selection.ranges.filter((_, rangeIndex) => rangeIndex !== index);
          const mainIndex = selection.mainIndex === index ? 0 : selection.mainIndex - Number(index < selection.mainIndex);
          return EditorSelection.create(ranges, mainIndex);
        }
      }
      const anchor = rangeAt(start.pos);
      const head = rangeAt(current.pos);
      const range = current.pos < start.pos ? EditorSelection.range(anchor.to, head.from) : EditorSelection.range(anchor.from, head.to);
      return selection.addRange(range);
    },
  };
}
