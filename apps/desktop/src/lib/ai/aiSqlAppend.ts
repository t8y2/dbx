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

/**
 * Append AI-generated SQL unless the exact text already exists as a standalone
 * editor block. AI appends use a blank line as their block separator, which
 * avoids treating a matching fragment inside a larger statement as a duplicate.
 */
export function buildDeduplicatedAppendedEditorSql(currentEditorSql: string, newSql: string): string {
  if (!newSql || containsStandaloneSqlBlock(currentEditorSql, newSql)) return currentEditorSql;
  return buildAppendedEditorSql(currentEditorSql, newSql);
}

function containsStandaloneSqlBlock(editorSql: string, sql: string): boolean {
  let from = 0;
  while (from <= editorSql.length - sql.length) {
    const index = editorSql.indexOf(sql, from);
    if (index < 0) return false;

    const before = editorSql.slice(0, index);
    const after = editorSql.slice(index + sql.length);
    const startsAtBlockBoundary = index === 0 || /(?:\r?\n){2}$/.test(before);
    const endsAtBlockBoundary = after.length === 0 || /^(?:\r?\n){2}/.test(after);
    if (startsAtBlockBoundary && endsAtBlockBoundary) return true;

    from = index + 1;
  }
  return false;
}
