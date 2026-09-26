import { EditorView } from "@codemirror/view";
import type { DatabaseType } from "@/types/database";

export const QUERY_EDITOR_ROOT_SELECTOR = "[data-query-editor-root]";
export const STRUCTURE_PEEK_PANEL_SELECTOR = "[data-structure-peek-panel]";

/** Dialect / connection metadata for inserting into a specific query editor view. */
export interface QueryEditorInsertContext {
  connectionId?: string;
  database?: string;
  schema?: string;
  databaseType?: DatabaseType;
}

let lastFocusedQueryEditorView: EditorView | null = null;
const insertContextByView = new WeakMap<EditorView, QueryEditorInsertContext>();

export function rememberFocusedQueryEditorView(view: EditorView | null | undefined): void {
  if (view) lastFocusedQueryEditorView = view;
}

/** Clear the remembered view when it is destroyed (or clear unconditionally). */
export function clearRememberedFocusedQueryEditorView(view?: EditorView | null): void {
  if (view == null || lastFocusedQueryEditorView === view) {
    lastFocusedQueryEditorView = null;
  }
}

export function registerQueryEditorInsertContext(view: EditorView, context: QueryEditorInsertContext): void {
  insertContextByView.set(view, context);
}

export function unregisterQueryEditorInsertContext(view: EditorView): void {
  insertContextByView.delete(view);
}

export function queryEditorInsertContext(view: EditorView): QueryEditorInsertContext | undefined {
  return insertContextByView.get(view);
}

/**
 * Resolve the CodeMirror view that should receive peek inserts.
 * - Focus inside a query editor → that view (must still report hasFocus).
 * - Focus inside a structure peek panel → most recently focused query editor.
 * - Focus elsewhere (sidebar, etc.) → null.
 */
export function focusedQueryEditorView(active: Element | null = typeof document !== "undefined" ? document.activeElement : null): EditorView | null {
  if (!(active instanceof Element)) return null;

  const root = active.closest(QUERY_EDITOR_ROOT_SELECTOR);
  if (root instanceof HTMLElement) {
    const view = EditorView.findFromDOM(root);
    if (!view?.hasFocus) return null;
    rememberFocusedQueryEditorView(view);
    return view;
  }

  if (active.closest(STRUCTURE_PEEK_PANEL_SELECTOR)) {
    const remembered = lastFocusedQueryEditorView;
    if (remembered?.dom.isConnected) return remembered;
    return null;
  }

  return null;
}

/** Keep editor focus when interacting with non-editable peek chrome (palette-style). */
export function shouldPreserveEditorFocusOnPeekPointerDown(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !target.closest("input, textarea, button, select, a, [contenteditable='true']");
}
