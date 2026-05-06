/**
 * Utilities for SQL identifier navigation (Ctrl/Cmd + click on table/column names).
 */

const SQL_KEYWORDS_SET = new Set([
  "select",
  "from",
  "where",
  "join",
  "left",
  "right",
  "inner",
  "outer",
  "on",
  "group",
  "by",
  "order",
  "asc",
  "desc",
  "having",
  "limit",
  "offset",
  "insert",
  "into",
  "values",
  "update",
  "set",
  "delete",
  "create",
  "table",
  "view",
  "as",
  "and",
  "or",
  "not",
  "in",
  "is",
  "null",
  "like",
  "distinct",
  "union",
  "all",
  "exists",
  "between",
  "case",
  "when",
  "then",
  "else",
  "end",
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "coalesce",
  "cast",
  "alter",
  "drop",
  "add",
  "column",
  "index",
  "primary",
  "key",
  "foreign",
  "references",
  "constraint",
  "default",
  "check",
  "unique",
  "begin",
  "commit",
  "rollback",
  "truncate",
  "explain",
  "analyze",
  "with",
  "recursive",
  "over",
  "partition",
  "row_number",
  "rank",
  "dense_rank",
  "lag",
  "lead",
  "first_value",
  "last_value",
  "ntile",
  "cross",
  "full",
  "natural",
  "using",
  "lateral",
  "unnest",
  "filter",
  "exclude",
  "replace",
  "qualify",
  "pivot",
  "unpivot",
  "asof",
  "positional",
  "anti",
  "semi",
  "sample",
  "struct",
  "map",
  "list",
  "array",
  "lambda",
  "copy",
  "export",
  "import",
  "describe",
  "show",
  "summarize",
  "pragma",
  "tablesample",
  "read_csv",
  "read_parquet",
  "read_json",
  "list_transform",
]);

/** Extract identifier at position `pos` in the document. */
export function extractIdentifierAt(doc: string, pos: number): string | null {
  if (pos < 0 || pos > doc.length) return null;

  const char = doc[pos];
  const idChar = (c: string) => /^[A-Za-z0-9_]$/.test(c);

  // Backtick-quoted: `identifier`
  if (char === "`") {
    let start = pos;
    while (start > 0 && doc[start - 1] === "`") start--;
    const end = doc.indexOf("`", start + 1);
    if (end < 0) return null;
    return doc.slice(start + 1, end);
  }

  // Double-quoted: "identifier"
  if (char === '"') {
    let start = pos;
    while (start > 0 && doc[start - 1] === '"') start--;
    const end = doc.indexOf('"', start + 1);
    if (end < 0) return null;
    return doc.slice(start + 1, end);
  }

  // Unquoted identifier (may be qualified like schema.table)
  if (!idChar(char) && char !== ".") return null;

  let start = pos;
  while (start > 0 && (idChar(doc[start - 1]) || doc[start - 1] === ".")) start--;
  let end = pos;
  while (end < doc.length && (idChar(doc[end]) || doc[end] === ".")) end++;

  const result = doc.slice(start, end);
  if (!/[A-Za-z0-9_]/.test(result)) return null;
  return result;
}

/** Check whether the identifier is a SQL keyword (not a table/column name). */
export function isSqlKeyword(identifier: string): boolean {
  return SQL_KEYWORDS_SET.has(identifier.toLowerCase());
}

/** Match identifier against known table names (case-insensitive). */
export function matchTable(
  identifier: string,
  tables: Array<{ name: string; schema?: string }>,
): { name: string; schema?: string } | null {
  const lower = identifier.toLowerCase();
  return tables.find((t) => t.name.toLowerCase() === lower) ?? null;
}
