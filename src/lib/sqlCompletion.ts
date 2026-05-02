const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER",
  "ON", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "INSERT",
  "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "VIEW",
  "AS", "AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE", "DISTINCT",
  "UNION", "ALL", "EXISTS", "BETWEEN", "CASE", "WHEN", "THEN", "ELSE", "END",
  "COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "CAST",
  "ALTER", "DROP", "ADD", "COLUMN", "INDEX", "PRIMARY", "KEY", "FOREIGN",
  "REFERENCES", "CONSTRAINT", "DEFAULT", "CHECK", "UNIQUE",
  "BEGIN", "COMMIT", "ROLLBACK", "TRUNCATE", "EXPLAIN", "ANALYZE",
  "WITH", "RECURSIVE", "OVER", "PARTITION BY", "ROW_NUMBER", "RANK", "DENSE_RANK",
  "LAG", "LEAD", "FIRST_VALUE", "LAST_VALUE", "NTILE",
  "CROSS", "FULL", "NATURAL", "USING", "LATERAL", "UNNEST",
  "FILTER", "EXCLUDE", "REPLACE", "QUALIFY", "PIVOT", "UNPIVOT",
  "ASOF", "POSITIONAL", "ANTI", "SEMI", "SAMPLE", "TABLESAMPLE",
  "STRUCT", "MAP", "LIST", "ARRAY", "LAMBDA", "LIST_TRANSFORM",
  "READ_CSV", "READ_PARQUET", "READ_JSON", "COPY", "EXPORT", "IMPORT",
  "DESCRIBE", "SHOW", "SUMMARIZE", "PRAGMA",
];

const TABLE_TRIGGER_KEYWORDS = new Set(["from", "join", "update", "into"]);

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

  if (context.suggestColumns) {
    items.push(...buildColumnItems(context, input.columnsByTable));
  }

  if (context.suggestTables) {
    items.push(...buildTableItems(context.prefix, input.tables));
  }

  if (!context.qualifier && !context.suggestTables) {
    items.push(...buildKeywordItems(context.prefix));
  }

  return dedupeAndSort(items);
}

export function getSqlCompletionContext(sql: string, cursor: number): SqlCompletionContext {
  const beforeCursor = sql.slice(0, cursor);
  const dottedMatch = /([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)?$/.exec(beforeCursor);
  const plainMatch = /([A-Za-z_][\w$]*)$/.exec(beforeCursor);
  const prefix = dottedMatch?.[2] ?? plainMatch?.[1] ?? "";
  const qualifier = dottedMatch?.[1];
  const bareStart = qualifier
    ? cursor - prefix.length
    : cursor - (plainMatch?.[1]?.length ?? 0);
  const beforeToken = beforeCursor.slice(0, Math.max(0, bareStart)).trimEnd();
  const lastWord = /([A-Za-z_][\w$]*)$/.exec(beforeToken)?.[1]?.toLowerCase() ?? "";
  const referencedTables = extractReferencedTables(sql);

  return {
    prefix,
    qualifier,
    suggestTables: TABLE_TRIGGER_KEYWORDS.has(lastWord),
    suggestColumns: !!qualifier || referencedTables.length > 0,
    referencedTables,
  };
}

function extractReferencedTables(sql: string): SqlCompletionReferencedTable[] {
  const pattern = /\b(?:from|join|update|into)\s+((?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*))?)(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?/gi;
  const referenced: SqlCompletionReferencedTable[] = [];
  for (const match of sql.matchAll(pattern)) {
    const rawName = match[1];
    const alias = match[2];
    const [first, second] = splitQualifiedName(rawName);
    if (!first) continue;
    const table = second ? { schema: first, name: second, alias } : { name: first, alias };
    referenced.push(table);
  }
  return referenced;
}

function splitQualifiedName(input: string): [string | undefined, string | undefined] {
  const parts = input.split(".").map((part) => unquoteIdentifier(part.trim())).filter(Boolean);
  if (parts.length >= 2) return [parts[0], parts[1]];
  return [parts[0], undefined];
}

function unquoteIdentifier(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("`") && value.endsWith("`"))) {
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
      boost: computeBoost(table.name, prefix),
    }));
}

function buildColumnItems(
  context: SqlCompletionContext,
  columnsByTable: Map<string, SqlCompletionColumn[]>,
): SqlCompletionItem[] {
  const relatedTables = context.qualifier
    ? context.referencedTables.filter((table) => table.alias === context.qualifier || table.name === context.qualifier)
    : context.referencedTables;

  const columns = relatedTables.flatMap((table) => {
    const key = table.schema ? `${table.schema}.${table.name}` : table.name;
    return columnsByTable.get(key) ?? [];
  });

  return columns
    .filter((column) => matchesPrefix(column.name, context.prefix))
    .map((column) => ({
      label: column.name,
      type: "column" as const,
      detail: column.schema ? `${column.schema}.${column.table}` : column.table,
      boost: computeBoost(column.name, context.prefix),
    }));
}

function buildKeywordItems(prefix: string): SqlCompletionItem[] {
  return SQL_KEYWORDS
    .filter((keyword) => matchesPrefix(keyword, prefix))
    .map((keyword) => ({
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
