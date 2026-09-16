import type { EditorState } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";
import { trailingStatementDelimiterPosition } from "@/lib/sql/statementDelimiter";
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

function sqlServerBatchStartsRoutine(sql: string): boolean {
  const goLine = /^[ \t]*GO(?:[ \t]+\d+)?[ \t]*(?:\r\n|\r|\n|$)/gim;
  let batchStart = 0;
  for (const match of sql.matchAll(goLine)) batchStart = (match.index ?? 0) + match[0].length;

  const batch = sql.slice(batchStart).replace(/^(?:\s|--[^\r\n]*(?:\r\n|\r|\n|$)|\/\*[\s\S]*?\*\/)+/u, "");
  return /^(?:CREATE(?:\s+OR\s+ALTER)?|ALTER)\s+(?:PROC(?:EDURE)?|FUNCTION|TRIGGER)\b/iu.test(batch);
}

export function shouldStartNextSqlStatementAtColumnZero(state: EditorState, databaseType?: DatabaseType): boolean {
  const terminator = trailingStatementTerminator(state);
  if (terminator === null) return false;

  const throughTerminator = state.sliceDoc(0, terminator + 1);
  if (databaseType === "sqlserver" && sqlServerBatchStartsRoutine(throughTerminator)) return false;

  // Appending one complete sentinel statement lets the shared splitter decide
  // whether this semicolon closes a top-level statement or is still inside a
  // routine/PLSQL block. Inspect the preceding range's actual delimiter so a
  // semicolon in a trailing comment cannot borrow an earlier statement boundary.
  const sentinelStart = throughTerminator.length + 1;
  const withTerminator = `${throughTerminator}\nSELECT 1;`;
  const ranges = splitSqlStatementRanges(withTerminator, databaseType);
  const sentinelIndex = ranges.findIndex((range) => range.from === sentinelStart);
  if (sentinelIndex <= 0) return false;

  const previousRange = ranges[sentinelIndex - 1];
  return previousRange.to === terminator + 1 || trailingStatementDelimiterPosition(withTerminator, previousRange.to) === terminator;
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
