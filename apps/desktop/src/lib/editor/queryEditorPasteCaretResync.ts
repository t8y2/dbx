/**
 * WebKit (Safari / macOS WKWebView) bug: after CodeMirror replaces DOM text
 * nodes for a paste, `document.getSelection()` reports the correct caret
 * position, but WebKit's native typing insertion point silently keeps
 * pointing at the pre-paste position — the next typed character lands there
 * instead of after the pasted text (e.g. typing "," after pasting "2" into
 * "1,|)" produces "1,,2)" instead of "1,2,)"). A genuine subsequent selection
 * change (as from an arrow key) forces WebKit to re-anchor correctly.
 *
 * Returns a nearby position to briefly move the caret to (and back from)
 * to replicate that nudge, or null if there is nowhere to nudge to.
 */
export interface PasteCaretSelection {
  ranges: readonly unknown[];
  main: { empty: boolean; head: number };
}

export function computePasteCaretResyncTarget(selection: PasteCaretSelection, docLength: number): number | null {
  if (selection.ranges.length !== 1 || !selection.main.empty) return null;
  const head = selection.main.head;
  const nudged = head < docLength ? head + 1 : head - 1;
  if (nudged === head || nudged < 0) return null;
  return nudged;
}
