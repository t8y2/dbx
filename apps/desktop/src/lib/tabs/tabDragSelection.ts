export const TAB_DRAG_SELECTION_CLASS = "dbx-tab-dragging";

const guards = new WeakMap<Document, { count: number; clearSelection: () => void; preventSelection: (event: Event) => void }>();

/** Source and destination previews can overlap in one WebView. */
export function blockTabDragTextSelection(doc: Document = document): () => void {
  let guard = guards.get(doc);
  if (!guard) {
    const clearSelection = () => {
      const selection = doc.getSelection();
      if (selection && !selection.isCollapsed) selection.removeAllRanges();
    };
    const preventSelection = (event: Event) => event.preventDefault();
    guard = { count: 0, clearSelection, preventSelection };
    guards.set(doc, guard);
    doc.documentElement.classList.add(TAB_DRAG_SELECTION_CLASS);
    doc.addEventListener("selectstart", preventSelection, true);
    doc.addEventListener("selectionchange", clearSelection);
    clearSelection();
  }
  guard.count += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--guard.count > 0) return;
    guard.clearSelection();
    doc.removeEventListener("selectstart", guard.preventSelection, true);
    doc.removeEventListener("selectionchange", guard.clearSelection);
    doc.documentElement.classList.remove(TAB_DRAG_SELECTION_CLASS);
    guards.delete(doc);
  };
}
