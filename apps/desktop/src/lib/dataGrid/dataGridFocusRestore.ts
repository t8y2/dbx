/**
 * Decide where focus should go when a kept-alive data grid becomes active
 * again after a tab switch.
 *
 * Switching away from a tab moves focus to the tab strip (or body), so the
 * grid root loses keyboard focus and arrow-key cell navigation stops working
 * when the user comes back. To match Navicat / DataGrip behavior, focus
 * returns to the element that last held it inside the grid (toolbar buttons,
 * search inputs, ...), falling back to the grid root when that element is
 * gone (e.g. a re-rendered cell editor).
 *
 * Returns null when no focus restore should happen: the grid never held
 * focus, or focus is already inside the grid (e.g. the cell editor restored
 * its own input focus first).
 */
export function resolveGridFocusRestoreTarget(root: HTMLElement | null | undefined, lastFocusedWithinGrid: HTMLElement | null | undefined, activeElement: Element | null): HTMLElement | null {
  if (!root || !lastFocusedWithinGrid) return null;
  if (root.contains(activeElement)) return null;
  if (lastFocusedWithinGrid.isConnected && root.contains(lastFocusedWithinGrid)) {
    return lastFocusedWithinGrid;
  }
  return root;
}
