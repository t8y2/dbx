import type { DatabaseType } from "@/types/database";

export interface ContextMenuExportSqlOptions {
  /** Text the user selected in the editor; an explicit selection always wins. */
  selectedSql: string;
  /** CodeMirror position of the context-menu invocation, or null when unknown. */
  position: number | null;
  /** Whole-document SQL used only when no statement can be resolved. */
  documentSql: string;
  /** Dialect used to parse the document (passed through to the backend splitter). */
  databaseType?: DatabaseType;
  /** Resolve the statement at a position with the backend statement splitter. */
  findStatementAtPosition: (sql: string, position: number, databaseType?: DatabaseType) => Promise<string>;
  /** Front-end statement range fallback for when the backend splitter is unavailable. */
  statementAtPosition: (position: number) => string | null;
}

/**
 * SQL for the editor context-menu "export current query result set" action.
 *
 * The action must export the statement the user right-clicked, mirroring the
 * execute action's statement scope (#1894): handing the backend the whole
 * editor document makes a multi-statement document look like a single
 * unsupported query, so the export is rejected before it starts.
 */
export async function resolveContextMenuExportSql(options: ContextMenuExportSqlOptions): Promise<string> {
  const selectedSql = options.selectedSql.trim();
  if (selectedSql) return selectedSql;
  if (options.position === null) return options.documentSql.trim();

  try {
    const resolved = (await options.findStatementAtPosition(options.documentSql, options.position, options.databaseType)).trim();
    if (resolved) return resolved;
  } catch {
    // The backend splitter is best-effort here; the front-end range keeps export usable offline.
  }

  return (options.statementAtPosition(options.position) ?? options.documentSql).trim();
}
