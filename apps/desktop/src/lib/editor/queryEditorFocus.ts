/**
 * Focus logic for the query editor CodeMirror view.
 *
 * Extracted from QueryEditor.vue so the guard condition can be unit-tested
 * without mounting the full Vue component.
 */

export interface EditorViewLike {
  hasFocus: boolean;
  focus(): void;
}

/**
 * Focus the editor if it exists and does not already have focus.
 * Returns `true` when `view.focus()` was actually called, `false` otherwise.
 */
export function focusEditorView(view: EditorViewLike | null | undefined): boolean {
  if (!view || view.hasFocus) return false;
  view.focus();
  return true;
}
