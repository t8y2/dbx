/**
 * Build the editor content after appending AI-generated SQL to existing editor SQL.
 * Preserves the existing editor content exactly and adds only the newline separator
 * needed to leave a blank line before the appended SQL.
 */
export function buildAppendedEditorSql(currentEditorSql: string, newSql: string): string {
  if (!currentEditorSql) return newSql;

  let separator = "\n\n";
  if (currentEditorSql.endsWith("\r\n\r\n") || currentEditorSql.endsWith("\n\n")) {
    separator = "";
  } else if (currentEditorSql.endsWith("\r\n")) {
    separator = "\r\n";
  } else if (currentEditorSql.endsWith("\n")) {
    separator = "\n";
  }

  return `${currentEditorSql}${separator}${newSql}`;
}
