import type { EditorState } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";
import { splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";
import type { DatabaseType } from "@/types/database";

function trailingStatementTerminator(state: EditorState): number | null {
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return null;

  const cursor = state.selection.main.head;
  const line = state.doc.lineAt(cursor);
  const match = /;[ \t]*$/.exec(state.sliceDoc(line.from, cursor));
  if (!match) return null;

  return line.from + match.index;
}

function sentinelStartsOwnStatement(sql: string, sentinelStart: number, databaseType?: DatabaseType): boolean {
  return splitSqlStatementRanges(sql, databaseType).findIndex((range) => range.from === sentinelStart) > 0;
}

export function shouldStartNextSqlStatementAtColumnZero(state: EditorState, databaseType?: DatabaseType): boolean {
  const terminator = trailingStatementTerminator(state);
  if (terminator === null) return false;

  // Appending a complete sentinel statement lets the shared splitter decide
  // whether this semicolon closes a top-level statement or is still inside a
  // procedure/PLSQL block. The sentinel starts its own range only in the former
  // case. This keeps routine-body indentation unchanged.
  const throughTerminator = state.sliceDoc(0, terminator + 1);
  const sentinelStart = throughTerminator.length + 1;
  const withTerminator = `${throughTerminator}\nSELECT 1;`;
  if (!sentinelStartsOwnStatement(withTerminator, sentinelStart, databaseType)) return false;

  // Parse the same prefix with the candidate semicolon removed. If the sentinel
  // is still independent, an earlier delimiter (rather than this semicolon)
  // created the boundary, which means the candidate is inside a comment/string.
  const withoutTerminator = `${throughTerminator.slice(0, -1)} \nSELECT 1;`;
  return !sentinelStartsOwnStatement(withoutTerminator, sentinelStart, databaseType);
}

export function insertQueryEditorNewline(view: EditorView, fallback: Command | null | undefined, databaseType?: DatabaseType): boolean {
  if (view.state.readOnly || !shouldStartNextSqlStatementAtColumnZero(view.state, databaseType)) {
    return fallback?.(view) ?? false;
  }

  const cursor = view.state.selection.main.head;
  view.dispatch(
    view.state.update({
      changes: { from: cursor, to: cursor, insert: "\n" },
      selection: { anchor: cursor + 1 },
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
}
