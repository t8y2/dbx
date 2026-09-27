import { orderedListRangeIndices, orderedListSelectionIntent } from "../selection/orderedListSelection";

/** Rows are identified by the server session id, matching the process list grid. */
export interface ProcessListSelectionRow {
  id: number;
}

export interface ProcessListSelectionState {
  selected: Set<number>;
  anchorId: number | null;
}

/**
 * Applies a row checkbox click to the current selection.
 *
 * A plain click toggles the clicked row and moves the anchor; Shift+click applies
 * the clicked row's next state to every selectable row between the anchor and the
 * clicked row, so long session lists can be selected in one gesture. Rows outside
 * the range keep their current state, and an unknown/stale anchor degrades to a
 * plain toggle instead of selecting an unexpected range.
 *
 * The next state is derived from the current selection because the grid binds
 * `:checked` without cancelling the native checkbox activation.
 */
export function processListSelectionAfterClick(rows: ProcessListSelectionRow[], state: ProcessListSelectionState, id: number, event: Pick<MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">): ProcessListSelectionState {
  const targetIndex = rows.findIndex((row) => row.id === id);
  if (targetIndex < 0) return state;
  const checked = !state.selected.has(id);
  const anchorIndex = state.anchorId === null ? -1 : rows.findIndex((row) => row.id === state.anchorId);
  if (orderedListSelectionIntent(event) === "range" && anchorIndex >= 0) {
    const selected = new Set(state.selected);
    for (const index of orderedListRangeIndices(rows.length, anchorIndex, targetIndex)) {
      const row = rows[index];
      if (!row) continue;
      if (checked) selected.add(row.id);
      else selected.delete(row.id);
    }
    return { selected, anchorId: state.anchorId };
  }
  const selected = new Set(state.selected);
  if (checked) selected.add(id);
  else selected.delete(id);
  return { selected, anchorId: id };
}
