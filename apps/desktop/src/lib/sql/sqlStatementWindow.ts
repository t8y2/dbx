import type { EditorState } from "@codemirror/state";
import { expandToSqlStatementWindow, type TextRange } from "@/lib/sql/insertValueHints";

type EditorStatementWindowResolver = (state: EditorState, cursor: number) => TextRange | null;

// The syntax-tree resolver lives in sqlSyntaxTreeWindow.ts, which pulls in @codemirror/language.
// This module stays free of CodeMirror runtime imports so SQL analysis reachable from app startup
// does not load the editor stack; sqlSyntaxTreeWindow.ts registers itself when an editor loads it.
// Without a registered resolver every lookup uses the bounded scanner, same as a call that has no
// EditorState.
let editorStatementWindowResolver: EditorStatementWindowResolver | null = null;

export function registerEditorStatementWindowResolver(resolver: EditorStatementWindowResolver) {
  editorStatementWindowResolver = resolver;
}

export function isEditorStatePlausibleFor(state: EditorState, sql: string): boolean {
  return state.doc.length === sql.length;
}

export function resolveSqlStatementWindow(sql: string, cursor: number, editorState: EditorState | undefined, dialectId: string): TextRange {
  const safeCursor = Math.max(0, Math.min(cursor, sql.length));
  if (editorState && editorStatementWindowResolver && isEditorStatePlausibleFor(editorState, sql)) {
    const window = editorStatementWindowResolver(editorState, safeCursor);
    if (window) return window;
  }
  return expandToSqlStatementWindow(sql, safeCursor, safeCursor, dialectId);
}
