/**
 * Chromium keeps using its own native insertion point for the next typed
 * character. When a decoration-only update (SQL / Redis syntax diagnostics)
 * wraps or unwraps the text nodes next to the caret, the browser collapses
 * that insertion point onto the surrounding line element instead of a text
 * node. `document.getSelection()` still reports a position that CodeMirror
 * considers equivalent to the caret — the same document position, only
 * expressed as (lineElement, childCount) instead of (textNode, offset) — so
 * CodeMirror leaves it alone, while the browser inserts the next character at
 * the start of the re-parented text node.
 *
 * Reported as #9480: after a short pause inside a Redis command argument
 * ("HGET us|"), the typed characters land at the start of the argument
 * ("HGET er:1us").
 *
 * Collapsing the DOM caret onto the precise DOM position of the editor
 * selection restores the insertion point. This has to happen outside a
 * CodeMirror transaction: a selection transaction would reset the completion
 * popup the user is currently looking at, and it is not needed because the
 * editor state already sits on that position.
 */
export interface DiagnosticCaretAnchorState {
  /** Whether the editor owns the browser focus. */
  hasFocus: boolean;
  /** Whether an IME composition is in progress — the browser owns the caret then. */
  composing: boolean;
  /** Number of ranges in the DOM selection of the editor root. */
  domRangeCount: number;
  /** Anchor node the browser currently uses for the caret. */
  currentAnchorNode: Node | null;
  currentAnchorOffset: number;
  /** Precise DOM position of the editor caret, or null when there is no single empty caret. */
  targetNode: Node | null;
  targetOffset: number;
}

export function needsDiagnosticCaretReanchor(state: DiagnosticCaretAnchorState): boolean {
  if (!state.hasFocus || state.composing) return false;
  if (state.domRangeCount !== 1) return false;
  if (!state.currentAnchorNode || !state.targetNode) return false;
  return state.currentAnchorNode !== state.targetNode || state.currentAnchorOffset !== state.targetOffset;
}
