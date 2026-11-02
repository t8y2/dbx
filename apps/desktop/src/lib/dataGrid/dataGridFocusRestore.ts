/**
 * Decide where focus should go when a kept-alive data grid becomes active
 * again after a tab switch.
 *
 * Switching away from a tab moves focus to the tab strip, body, or an element
 * inside the grid that is being deactivated. Focus is restored only from one
 * of those states so activation never steals focus from a dialog, editor,
 * input, menu, or another active grid.
 *
 * Returns null when no focus restore should happen: the grid never held
 * focus, or focus is already inside the grid (e.g. the cell editor restored
 * its own input focus first).
 */
export function resolveGridFocusRestoreTarget(root: HTMLElement | null | undefined, lastFocusedWithinGrid: HTMLElement | null | undefined, activeElement: Element | null): HTMLElement | null {
  if (!root || !lastFocusedWithinGrid) return null;
  if (root.contains(activeElement)) return null;
  if (!gridFocusCanTransferFrom(root, activeElement)) return null;
  if (lastFocusedWithinGrid.isConnected && root.contains(lastFocusedWithinGrid)) {
    return lastFocusedWithinGrid;
  }
  return root;
}

function gridFocusCanTransferFrom(root: HTMLElement, activeElement: Element | null): boolean {
  if (!activeElement || !activeElement.isConnected) return true;
  const ownerDocument = root.ownerDocument;
  if (activeElement === ownerDocument?.body || activeElement === ownerDocument?.documentElement) return true;

  const closest = (activeElement as HTMLElement).closest?.bind(activeElement as HTMLElement);
  if (!closest) return false;
  const activeGrid = closest("[data-grid-root]") as HTMLElement | null;
  if (activeGrid && activeGrid !== root) return activeGrid.dataset.gridActive !== "true";
  return !!closest(".app-tab-bar, [role='tab'], [role='tablist']");
}

/**
 * Decide whether a committed cell edit should hand focus back to the grid.
 *
 * Keyboard commits (Enter, inline bulk edit) leave focus inside the grid, so
 * the grid must take it back for arrow-key navigation to keep working. A commit
 * that ended because an outside pointer interaction moved focus elsewhere — the
 * SQL editor, the WHERE condition bar, a toolbar button — must not, otherwise
 * the element the user just clicked never keeps the caret, and the next
 * keystroke or paste is claimed by the grid instead (#9383).
 */
export function shouldRestoreDataGridFocusAfterEditCommit(root: HTMLElement | null | undefined, activeElement: Element | null): boolean {
  if (!root) return true;
  if (root.contains(activeElement)) return true;
  return gridFocusCanTransferFrom(root, activeElement);
}
