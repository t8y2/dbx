import { findStatementAtCursor } from "./sqlStatementSplit";

export type ExecuteMode = "all" | "current";

export function resolveExecutableSql(
  fullSql: string,
  selectedSql: string,
  options?: { mode?: ExecuteMode; cursorPos?: number },
): string {
  const trimmedSelection = selectedSql.trim();
  if (trimmedSelection) return trimmedSelection;

  if (options?.mode === "current" && options.cursorPos !== undefined) {
    return findStatementAtCursor(fullSql, options.cursorPos);
  }

  return fullSql;
}
