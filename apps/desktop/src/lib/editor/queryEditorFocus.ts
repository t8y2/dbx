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

const PRESERVED_EDITOR_FOCUS_SELECTOR = "[data-preserve-editor-focus]";

/**
 * A surrounding surface can temporarily own focus while a query editor is
 * mounting (for example, the SQL library's inline rename input). Query editor
 * autofocus must respect that handoff instead of immediately stealing focus.
 */
function focusPreservedElement(): boolean {
  if (typeof document === "undefined") return false;
  const target = document.querySelector<HTMLElement>(PRESERVED_EDITOR_FOCUS_SELECTOR);
  if (!target || document.activeElement !== target) return false;
  target.focus();
  return true;
}

/**
 * Focus the editor if it exists and does not already have focus, while
 * respecting a surrounding control that currently owns a focus handoff.
 * Returns `true` when `view.focus()` was actually called, `false` otherwise.
 */
export function focusEditorView(view: EditorViewLike | null | undefined): boolean {
  if (focusPreservedElement()) return false;
  if (!view || view.hasFocus) return false;
  view.focus();
  return true;
}
