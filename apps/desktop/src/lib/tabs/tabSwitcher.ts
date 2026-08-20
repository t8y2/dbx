/**
 * Ordering and selection helpers for the JetBrains-style Ctrl+Tab switcher.
 * Pure functions so the behavior is unit-testable without mounting the UI.
 */

/**
 * Orders tabs by most-recent use: tabs that appear in `mruIds` (oldest first,
 * as recorded on activation) come first in reverse-chronological order; tabs
 * never visited (e.g. restored from a previous session) follow in tab-bar
 * order. Ids that no longer have a tab are dropped.
 */
export function tabSwitcherOrder<T extends { id: string }>(tabs: readonly T[], mruIds: readonly string[]): T[] {
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]));
  const ordered: T[] = [];
  const seen = new Set<string>();

  for (let i = mruIds.length - 1; i >= 0; i--) {
    const id = mruIds[i]!;
    if (seen.has(id)) continue;
    seen.add(id);
    const tab = tabById.get(id);
    if (tab) ordered.push(tab);
  }
  for (const tab of tabs) {
    if (!seen.has(tab.id)) ordered.push(tab);
  }
  return ordered;
}

/** Initial highlight when the switcher opens: the previous tab, so a quick tap toggles between the two most recent tabs. */
export function initialTabSwitcherSelection(count: number): number {
  return count > 1 ? 1 : 0;
}

/** Moves the highlight with wrap-around; returns -1 when there is nothing to select. */
export function moveTabSwitcherSelection(current: number, delta: -1 | 1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}
