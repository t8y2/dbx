// Shift range selection for the Settings → Snippets list checkboxes: the last
// plain-clicked row acts as the anchor, and shift-clicking another row sets
// every row between the two (endpoints included, in visible-row order) to one
// state — callers pass the clicked row's post-toggle state (whatever the click
// turned it into, the whole range follows), defaulting to the anchor's current
// state. Returns null when there is no anchor, the anchor is not among the
// visible rows (filtered out or deleted), or the clicked row is the anchor
// itself, so callers fall back to a plain single-row toggle.
export function applySnippetRangeSelection(selected: ReadonlySet<string>, rows: ReadonlyArray<{ id: string }>, anchorId: string | undefined, clickedId: string, checked?: boolean): Set<string> | null {
  if (!anchorId || anchorId === clickedId) return null;
  const anchorIndex = rows.findIndex((row) => row.id === anchorId);
  const clickedIndex = rows.findIndex((row) => row.id === clickedId);
  if (anchorIndex < 0 || clickedIndex < 0) return null;
  const on = checked ?? selected.has(anchorId);
  const next = new Set(selected);
  const from = Math.min(anchorIndex, clickedIndex);
  const to = Math.max(anchorIndex, clickedIndex);
  for (let index = from; index <= to; index += 1) {
    const id = rows[index]!.id;
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}
