import { EditorSelection, type EditorState } from "@codemirror/state";
import { SearchCursor, selectNextOccurrence } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";

const MAX_OCCURRENCE_SELECTIONS = 1000;

function selectionOccurrenceQuery(state: EditorState): string | null {
  const ranges = state.selection.ranges;
  if (ranges.length === 1 && ranges[0].empty) {
    const word = state.wordAt(ranges[0].head);
    return word ? state.sliceDoc(word.from, word.to) : null;
  }

  const query = state.sliceDoc(ranges[0].from, ranges[0].to);
  if (!query.trim()) return null;
  return ranges.every((range) => !range.empty && state.sliceDoc(range.from, range.to) === query) ? query : null;
}

export function addNextQueryEditorSelectionOccurrence(view: EditorView): boolean {
  const ranges = view.state.selection.ranges;
  const hasEmptyRange = ranges.some((range) => range.empty);
  if (hasEmptyRange && ranges.length > 1) {
    // The single-cursor word-expansion helper cannot run with multiple
    // cursors; CodeMirror's native command word-expands every empty range
    // and adds the next occurrence of the shared query.
    return selectNextOccurrence(view);
  }
  if (hasEmptyRange && !selectCurrentWord(view)) return false;
  return selectNextOccurrence(view);
}

export function selectAllQueryEditorSelectionOccurrences(view: EditorView): boolean {
  const query = selectionOccurrenceQuery(view.state);
  if (!query) return false;

  const ranges = [];
  let mainIndex = 0;
  const main = view.state.selection.main;
  const cursor = new SearchCursor(view.state.doc, query);
  for (let match = cursor.next(); !match.done; match = cursor.next()) {
    if (ranges.length >= MAX_OCCURRENCE_SELECTIONS) return false;
    if (match.value.from === main.from) mainIndex = ranges.length;
    ranges.push(EditorSelection.range(match.value.from, match.value.to));
  }
  if (!ranges.length) return false;
  view.dispatch({ selection: EditorSelection.create(ranges, mainIndex), userEvent: "select.search.matches" });
  return true;
}

function selectCurrentWord(view: EditorView): boolean {
  const selection = view.state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;

  const word = view.state.wordAt(selection.main.head);
  if (!word || word.from === word.to) return false;

  view.dispatch({ selection: EditorSelection.single(word.from, word.to), scrollIntoView: true, userEvent: "select.search" });
  return true;
}
