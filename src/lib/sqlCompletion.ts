const SQL_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "ON",
  "GROUP BY",
  "ORDER BY",
  "ASC",
  "DESC",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "INSERT",
  "INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE",
  "CREATE",
  "TABLE",
  "VIEW",
  "AS",
  "AND",
  "OR",
  "NOT",
  "IN",
  "IS",
  "NULL",
  "LIKE",
  "DISTINCT",
  "UNION",
  "ALL",
  "EXISTS",
  "BETWEEN",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COALESCE",
  "CAST",
  "ALTER",
  "DROP",
  "ADD",
  "COLUMN",
  "INDEX",
  "PRIMARY",
  "KEY",
  "FOREIGN",
  "REFERENCES",
  "CONSTRAINT",
  "DEFAULT",
  "CHECK",
  "UNIQUE",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "TRUNCATE",
  "EXPLAIN",
  "ANALYZE",
  "WITH",
  "RECURSIVE",
  "OVER",
  "PARTITION BY",
  "ROW_NUMBER",
  "RANK",
  "DENSE_RANK",
  "LAG",
  "LEAD",
  "FIRST_VALUE",
  "LAST_VALUE",
  "NTILE",
  "CROSS",
  "FULL",
  "NATURAL",
  "USING",
  "LATERAL",
  "UNNEST",
  "FILTER",
  "EXCLUDE",
  "REPLACE",
  "QUALIFY",
  "PIVOT",
  "UNPIVOT",
  "ASOF",
  "POSITIONAL",
  "ANTI",
  "SEMI",
  "SAMPLE",
  "TABLESAMPLE",
  "STRUCT",
  "MAP",
  "LIST",
  "ARRAY",
  "LAMBDA",
  "LIST_TRANSFORM",
  "READ_CSV",
  "READ_PARQUET",
  "READ_JSON",
  "COPY",
  "EXPORT",
  "IMPORT",
  "DESCRIBE",
  "SHOW",
  "SUMMARIZE",
  "PRAGMA",
];

const TABLE_TRIGGER_KEYWORDS = new Set(["from", "join", "update", "into", "table", "describe", "explain"]);
const JOIN_MODIFIERS = new Set(["left", "right", "inner", "outer", "cross", "full", "natural"]);

export interface SqlCompletionTable {
  name: string;
  schema?: string;
  type?: "table" | "view";
}

export interface SqlCompletionColumn {
  name: string;
  table: string;
  schema?: string;
  dataType?: string;
}

export interface SqlCompletionItem {
  label: string;
  type: "keyword" | "table" | "column";
  detail?: string;
  boost: number;
}

export interface SqlCompletionReferencedTable {
  name: string;
  schema?: string;
  alias?: string;
}

export interface SqlCompletionContext {
  prefix: string;
  qualifier?: string;
  suggestTables: boolean;
  suggestColumns: boolean;
  suggestKeywords: boolean;
  referencedTables: SqlCompletionReferencedTable[];
}

export function buildSqlCompletionItems(
  sql: string,
  cursor: number,
  input: {
    tables: SqlCompletionTable[];
    columnsByTable: Map<string, SqlCompletionColumn[]>;
  },
): SqlCompletionItem[] {
  const context = getSqlCompletionContext(sql, cursor);
  return buildSqlCompletionItemsFromContext(context, input);
}

export function buildSqlCompletionItemsFromContext(
  context: SqlCompletionContext,
  input: {
    tables: SqlCompletionTable[];
    columnsByTable: Map<string, SqlCompletionColumn[]>;
  },
): SqlCompletionItem[] {
  const items: SqlCompletionItem[] = [];

  // Always suggest keywords (regardless of qualifier)
  if (context.suggestKeywords) {
    items.push(...buildKeywordItems(context.prefix));
  }

  if (context.suggestColumns) {
    items.push(...buildColumnItems(context, input.columnsByTable));
  }

  if (context.suggestTables) {
    items.push(...buildTableItems(context.prefix, input.tables));
  }

  return dedupeAndSort(items);
}

/**
 * Extract the SQL statement that contains the cursor position.
 * Splits on semicolons but ignores those inside string literals.
 */
function extractStatementAt(sql: string, cursor: number): string {
  // Find the start of the statement containing cursor
  let start = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
    else if (ch === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
    else if (ch === ";" && !inSingleQuote && !inDoubleQuote) {
      if (i < cursor) {
        start = i + 1;
        while (start < sql.length && /\s/.test(sql[start])) start++;
      }
    }
  }
  // Find the end of the statement (next semicolon at or after cursor)
  let end = sql.length;
  inSingleQuote = false;
  inDoubleQuote = false;
  for (let i = start; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
    else if (ch === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
    else if (ch === ";" && !inSingleQuote && !inDoubleQuote && i >= cursor) {
      end = i;
      break;
    }
  }
  return sql.slice(start, end).trim();
}

export function getSqlCompletionContext(sql: string, cursor: number): SqlCompletionContext {
  // Extract the full statement at cursor position (respects semicolons and string literals)
  const fullStatement = extractStatementAt(sql, cursor);

  // Simpler approach: just use sql.slice(0, cursor) but find start of current stmt
  const stmtStart = extractStatementStart(sql, cursor);
  const beforeCursor = sql.slice(stmtStart, cursor);

  const dottedMatch = /([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)?$/.exec(beforeCursor);
  const plainMatch = /([A-Za-z_][\w$]*)$/.exec(beforeCursor);
  const prefix = dottedMatch?.[2] ?? plainMatch?.[1] ?? "";
  const qualifier = dottedMatch?.[1];
  const bareStart = qualifier
    ? beforeCursor.length - prefix.length
    : beforeCursor.length - (plainMatch?.[1]?.length ?? 0);
  const beforeToken = beforeCursor.slice(0, Math.max(0, bareStart)).trimEnd();
  const lastWord = /([A-Za-z_][\w$]*)$/.exec(beforeToken)?.[1]?.toLowerCase() ?? "";

  const referencedTables = extractReferencedTables(fullStatement);

  const afterTableTrigger =
    TABLE_TRIGGER_KEYWORDS.has(lastWord) ||
    (JOIN_MODIFIERS.has(lastWord) && isFollowedByJoin(beforeToken)) ||
    isInTableListContext(beforeToken);

  // Check if we're in a context where columns are expected (based on content before cursor)
  const inColumnContext = isInColumnContext(beforeCursor.trimEnd());

  return {
    prefix,
    qualifier,
    // Suggest tables ONLY after FROM/JOIN/UPDATE/INTO/etc keywords
    suggestTables: afterTableTrigger,
    // Suggest columns when:
    // 1. There's a table qualifier (table.column)
    // 2. We're in a column context (WHERE, ON, etc.) AND there are referenced tables
    suggestColumns: !!qualifier || (inColumnContext && referencedTables.length > 0),
    // Always suggest keywords
    suggestKeywords: true,
    referencedTables,
  };
}

/**
 * Find the start position of the SQL statement containing the cursor.
 */
function extractStatementStart(sql: string, cursor: number): number {
  let start = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
    else if (ch === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
    else if (ch === ";" && !inSingleQuote && !inDoubleQuote) {
      if (i < cursor) {
        start = i + 1;
        while (start < sql.length && /\s/.test(sql[start])) start++;
      }
    }
  }
  return start;
}

/**
 * Check if the context before the current token is a column-expected context.
 * beforeToken is everything before the current token being typed.
 */
function isInColumnContext(beforeToken: string): boolean {
  if (!beforeToken) return false;

  // Strip string literals
  const cleaned = beforeToken.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, "''");

  // Get all words
  const lastWords = cleaned.trimEnd().split(/\s+/);
  // Check the last word AND the second-to-last word
  // because `beforeToken` already excludes the prefix being typed
  for (let i = lastWords.length - 1; i >= Math.max(0, lastWords.length - 3); i--) {
    const word = lastWords[i]?.toLowerCase().replace(/[^a-z0-9.]/g, "") ?? "";
    // Operators that indicate column context
    if (/^[=<>!\+\-\*\/(,]$/.test(word)) return true;
    // Keywords that directly precede column expressions
    if (["where", "on", "having", "set", "and", "or", "not", "is", "like", "in", "between", "select"].includes(word)) {
      return true;
    }
    // "ORDER BY" / "GROUP BY" — when we see "by", check the word before it
    if (word === "by" && i > 0) {
      const prevWord = lastWords[i - 1]?.toLowerCase() ?? "";
      if (["order", "group"].includes(prevWord)) return true;
    }
  }

  return false;
}

function extractReferencedTables(sql: string): SqlCompletionReferencedTable[] {
  // Keywords that should NOT be treated as table aliases
  const ALIAS_BLACKLIST = new Set([
    "where",
    "group",
    "order",
    "having",
    "limit",
    "offset",
    "union",
    "intersect",
    "except",
    "and",
    "or",
    "not",
    "is",
    "like",
    "in",
    "between",
    "exists",
    "select",
    "from",
    "join",
    "left",
    "right",
    "inner",
    "outer",
    "cross",
    "full",
    "natural",
    "on",
    "as",
    "set",
    "insert",
    "update",
    "delete",
    "create",
    "drop",
    "alter",
    "into",
    "values",
    "returning",
    "for",
    "window",
    "partition",
    "over",
    "with",
    "recursive",
    "lateral",
    "when",
    "then",
    "else",
    "end",
    "case",
    "cast",
    "coalesce",
    "null",
    "true",
    "false",
    "distinct",
    "all",
    "primary",
    "key",
    "foreign",
    "references",
    "constraint",
    "default",
    "check",
    "unique",
    "index",
    "table",
    "view",
    "database",
    "schema",
    "describe",
    "explain",
    "analyze",
    "pivot",
    "unpivot",
    "asof",
    "positional",
    "anti",
    "semi",
    "sample",
    "filter",
    "qualify",
    "offset",
    "fetch",
    "next",
    "rows",
    "only",
    "preceding",
    "following",
    "current",
    "unbounded",
    "asc",
    "desc",
    "nulls",
    "first",
    "last",
    "ignore",
    "respect",
  ]);

  const pattern =
    /\b(?:from|join|update|into)\s+((?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*))?)(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?/gi;
  const referenced: SqlCompletionReferencedTable[] = [];
  for (const match of sql.matchAll(pattern)) {
    const rawName = match[1];
    const alias = match[2];
    const [first, second] = splitQualifiedName(rawName);
    if (!first) continue;
    // Filter out SQL keywords that accidentally matched as aliases
    const cleanAlias = alias && !ALIAS_BLACKLIST.has(alias.toLowerCase()) ? alias : undefined;
    const table = second ? { schema: first, name: second, alias: cleanAlias } : { name: first, alias: cleanAlias };
    referenced.push(table);
  }
  return referenced;
}

function splitQualifiedName(input: string): [string | undefined, string | undefined] {
  const parts = input
    .split(".")
    .map((part) => unquoteIdentifier(part.trim()))
    .filter(Boolean);
  if (parts.length >= 2) return [parts[0], parts[1]];
  return [parts[0], undefined];
}

function unquoteIdentifier(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("`") && value.endsWith("`"))) {
    return value.slice(1, -1);
  }
  return value;
}

function buildTableItems(prefix: string, tables: SqlCompletionTable[]): SqlCompletionItem[] {
  return tables
    .filter((table) => matchesPrefix(table.name, prefix))
    .map((table) => ({
      label: table.name,
      type: "table" as const,
      detail: table.schema ? `${table.schema}.${table.name}` : table.type,
      boost: computeBoost(table.name, prefix) + 1000,
    }));
}

function isFollowedByJoin(beforeToken: string): boolean {
  const words = beforeToken.trimEnd().split(/\s+/);
  const second = words[words.length - 2]?.toLowerCase();
  return second === "join" || JOIN_MODIFIERS.has(second ?? "");
}

function isInTableListContext(beforeToken: string): boolean {
  return /,\s*$/.test(beforeToken) && /\b(?:from|join|update|into)\b/i.test(beforeToken);
}

function buildColumnItems(
  context: SqlCompletionContext,
  columnsByTable: Map<string, SqlCompletionColumn[]>,
): SqlCompletionItem[] {
  // Collect all columns from the map (all tables have been fetched)
  const allColumns: Array<SqlCompletionColumn & { key: string }> = [];
  for (const [key, cols] of columnsByTable.entries()) {
    for (const col of cols) {
      allColumns.push({ ...col, key });
    }
  }

  // If there's a qualifier (e.g., c.card_name), filter to tables matching the qualifier
  let relevantCols = allColumns;
  if (context.qualifier) {
    const q = context.qualifier;
    const qLower = q.toLowerCase();
    // Find tables whose name OR alias matches the qualifier
    const relatedTables = context.referencedTables.filter(
      (table) =>
        table.alias === q ||
        table.alias?.toLowerCase() === qLower ||
        table.name === q ||
        table.name.toLowerCase() === qLower,
    );
    const tableKeys = new Set(
      relatedTables.map((table) => (table.schema ? `${table.schema}.${table.name}` : table.name)),
    );
    // Filter columns by key (schema.table) or by table name matching the qualifier
    relevantCols = allColumns.filter((c) => tableKeys.has(c.key) || c.table.toLowerCase() === qLower);
  }

  // Deduplicate columns by name
  const seen = new Set<string>();
  const uniqueColumns = relevantCols.filter((c) => {
    if (seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });

  return uniqueColumns
    .filter((column) => matchesPrefix(column.name, context.prefix))
    .map((column) => ({
      label: column.name,
      type: "column" as const,
      detail: column.schema ? `${column.schema}.${column.table}` : column.table,
      boost: computeBoost(column.name, context.prefix),
    }));
}

function buildKeywordItems(prefix: string): SqlCompletionItem[] {
  return SQL_KEYWORDS.filter((keyword) => matchesPrefix(keyword, prefix)).map((keyword) => ({
    label: keyword,
    type: "keyword" as const,
    boost: computeBoost(keyword, prefix),
  }));
}

function matchesPrefix(candidate: string, prefix: string): boolean {
  if (!prefix) return true;
  return candidate.toLowerCase().includes(prefix.toLowerCase());
}

function computeBoost(candidate: string, prefix: string): number {
  if (!prefix) return 1;
  const startsWith = candidate.toLowerCase().startsWith(prefix.toLowerCase());
  return (startsWith ? 1000 : 100) - candidate.length;
}

function dedupeAndSort(items: SqlCompletionItem[]): SqlCompletionItem[] {
  const seen = new Set<string>();
  return items
    .sort((left, right) => right.boost - left.boost)
    .filter((item) => {
      const key = `${item.type}:${item.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
