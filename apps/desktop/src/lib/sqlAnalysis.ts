// Binary column types that should not be edited inline
export const BINARY_TYPES = new Set(["blob", "clob", "bytea", "varbinary", "binary", "image", "longblob", "mediumblob", "tinyblob", "blob sub_type 2004", "blob sub_type 2005"]);

export function isBinaryType(dataType: string): boolean {
  const lower = dataType
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
  return BINARY_TYPES.has(lower);
}

export interface EditableQueryInfo {
  schema: string | undefined;
  schemaQuoted?: boolean;
  tableName: string;
  tableNameQuoted?: boolean;
  tableAlias?: string;
  selectStar: boolean;
  columns: EditableQueryColumn[]; // empty array if SELECT *
}

export interface EditableQueryColumn {
  sourceName?: string;
  sourceNameQuoted?: boolean;
  resultName: string;
  expression: string;
}

export type QueryEditabilityReason = "not-select" | "cte" | "set-operation" | "aggregation" | "external-source" | "complex-source" | "computed-columns" | "no-table" | "no-primary-key" | "primary-key-not-returned" | "aliased-columns" | "metadata-unavailable";

export type QueryEditability = { editable: true; analysis: EditableQueryInfo } | { editable: false; reason: QueryEditabilityReason };

/**
 * Parse a SELECT statement to determine if it's editable.
 * Only simple single-table SELECT queries are considered editable:
 * - No JOIN, GROUP BY, HAVING, UNION, subqueries, CTEs, DISTINCT, aggregations
 * - Must have a single FROM clause with one table
 * - WHERE, ORDER BY, LIMIT are allowed
 */
export function analyzeEditableQuery(sql: string): EditableQueryInfo | null {
  const result = analyzeEditableQueryEditability(sql);
  return result.editable ? result.analysis : null;
}

export function analyzeEditableQueryEditability(sql: string): QueryEditability {
  const normalized = stripSqlComments(sql)
    .replace(/;+\s*$/, "")
    .trim();
  if (!normalized) return { editable: false, reason: "not-select" };
  if (/^\s*WITH\b/i.test(normalized)) return { editable: false, reason: "cte" };
  if (!/^SELECT\b/i.test(normalized)) return { editable: false, reason: "not-select" };
  if (hasTopLevelKeyword(normalized, ["UNION", "INTERSECT", "EXCEPT"])) {
    return { editable: false, reason: "set-operation" };
  }
  if (normalized.includes(";")) return { editable: false, reason: "complex-source" };

  const fromIndex = findTopLevelKeyword(normalized, "FROM", 0);
  if (fromIndex < 0) return { editable: false, reason: "no-table" };

  const selectBody = normalized.slice("SELECT".length, fromIndex).trim();
  if (/^DISTINCT\b/i.test(selectBody)) return { editable: false, reason: "aggregation" };

  const groupIndex = findTopLevelKeyword(normalized, "GROUP", fromIndex + 4);
  const havingIndex = findTopLevelKeyword(normalized, "HAVING", fromIndex + 4);
  if (groupIndex >= 0 || havingIndex >= 0) return { editable: false, reason: "aggregation" };

  const fromEnd = firstTopLevelKeywordIndex(normalized, ["WHERE", "ORDER", "LIMIT", "OFFSET", "FETCH"], fromIndex + 4);
  const fromBody = normalized.slice(fromIndex + 4, fromEnd < 0 ? normalized.length : fromEnd).trim();
  if (isExternalFromSource(fromBody)) return { editable: false, reason: "external-source" };
  const source = parseFromSource(fromBody);
  if (!source) return { editable: false, reason: "complex-source" };

  const selectStar = isSelectStar(selectBody, source.alias);
  const columns = selectStar ? [] : parseSelectColumns(selectBody);
  if (!selectStar && columns.length === 0) return { editable: false, reason: "computed-columns" };

  return {
    editable: true,
    analysis: {
      schema: source.schema,
      schemaQuoted: source.schemaQuoted,
      tableName: source.tableName,
      tableNameQuoted: source.tableNameQuoted,
      tableAlias: source.alias,
      selectStar,
      columns,
    },
  };
}

export function queryEditabilityMessageKey(reason: QueryEditabilityReason): string {
  return {
    "not-select": "grid.queryEditUnsupportedNotSelect",
    cte: "grid.queryEditUnsupportedCte",
    "set-operation": "grid.queryEditUnsupportedSetOperation",
    aggregation: "grid.queryEditUnsupportedAggregation",
    "external-source": "grid.queryEditUnsupportedExternalSource",
    "complex-source": "grid.queryEditUnsupportedComplexSource",
    "computed-columns": "grid.queryEditUnsupportedComputedColumns",
    "no-table": "grid.queryEditUnsupportedNoTable",
    "no-primary-key": "grid.queryEditUnsupportedNoPrimaryKey",
    "primary-key-not-returned": "grid.queryEditUnsupportedPrimaryKeyNotReturned",
    "aliased-columns": "grid.queryEditUnsupportedAliasedColumns",
    "metadata-unavailable": "grid.queryEditUnsupportedMetadataUnavailable",
  }[reason];
}

function parseSelectColumns(body: string): EditableQueryColumn[] {
  const cols: EditableQueryColumn[] = [];
  let depth = 0;
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      current += ch;
      if (ch === quote || (quote === "]" && ch === "]")) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "[") quote = "]";
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      const col = parseSelectColumn(current.trim());
      if (!col) return [];
      cols.push(col);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    const col = parseSelectColumn(current.trim());
    if (!col) return [];
    cols.push(col);
  }
  return cols;
}

function parseSelectColumn(col: string): EditableQueryColumn | null {
  const source = parseQualifiedIdentifier(col);
  if (!source) return parseComputedSelectColumn(col);
  const alias = parseColumnAlias(source.rest);
  if (alias === null) return parseComputedSelectColumn(col);
  return {
    sourceName: source.parts[source.parts.length - 1],
    sourceNameQuoted: source.quoted[source.quoted.length - 1],
    resultName: alias ?? source.parts[source.parts.length - 1],
    expression: col.slice(0, source.end).trim(),
  };
}

function parseComputedSelectColumn(col: string): EditableQueryColumn | null {
  const alias = parseExpressionAlias(col);
  if (!alias) return null;
  return {
    sourceName: undefined,
    sourceNameQuoted: false,
    resultName: alias.resultName,
    expression: alias.expression,
  };
}

function parseExpressionAlias(col: string): { expression: string; resultName: string } | null {
  const asMatch = col.match(/\bAS\s+((?:"[^"]+")|(?:`[^`]+`)|(?:\[[^\]]+\])|(?:[A-Za-z_][\w$]*))\s*$/i);
  if (asMatch?.index === undefined) return null;
  const alias = readIdentifier(asMatch[1], 0);
  if (!alias || alias.end !== asMatch[1].length) return null;
  const expression = col.slice(0, asMatch.index).trim();
  return expression ? { expression, resultName: alias.value } : null;
}

function parseColumnAlias(rest: string): string | undefined | null {
  const trimmed = rest.trim();
  if (!trimmed) return undefined;
  const asMatch = trimmed.match(/^AS\s+/i);
  const aliasText = asMatch ? trimmed.slice(asMatch[0].length).trim() : trimmed;
  const alias = readIdentifier(aliasText, 0);
  if (!alias || alias.end !== aliasText.length) return null;
  return alias.value;
}

function isSelectStar(body: string, alias: string | undefined): boolean {
  const trimmed = body.trim();
  if (trimmed === "*") return true;
  if (!alias) return false;
  return new RegExp(`^${escapeRegExp(alias)}\\s*\\.\\s*\\*$`, "i").test(trimmed);
}

function parseFromSource(body: string): { schema?: string; schemaQuoted?: boolean; tableName: string; tableNameQuoted?: boolean; alias?: string } | null {
  if (!body || /[,()]/.test(body) || /\bJOIN\b/i.test(body)) return null;
  const ident = parseQualifiedIdentifier(body);
  if (!ident || ident.parts.length < 1 || ident.parts.length > 2) return null;
  const tail = ident.rest.trim();
  let alias: string | undefined;
  if (tail) {
    const aliasText = tail.replace(/^AS\s+/i, "").trim();
    const aliasIdent = readIdentifier(aliasText, 0);
    if (!aliasIdent || aliasIdent.end !== aliasText.length) return null;
    alias = aliasIdent.value;
  }
  const tableName = ident.parts[ident.parts.length - 1];
  const tableNameQuoted = ident.quoted[ident.quoted.length - 1];
  const schema = ident.parts.length === 2 ? ident.parts[0] : undefined;
  const schemaQuoted = ident.parts.length === 2 ? ident.quoted[0] : false;
  return { schema, schemaQuoted, tableName, tableNameQuoted, alias };
}

function isExternalFromSource(body: string): boolean {
  const trimmed = body.trim();
  return /^'(?:''|[^'])*'(?:\s+(?:AS\s+)?[A-Za-z_][\w$]*)?$/i.test(trimmed) || /^[A-Za-z_][\w$]*\s*\(/.test(trimmed);
}

function parseQualifiedIdentifier(text: string): { parts: string[]; quoted: boolean[]; end: number; rest: string; done: boolean } | null {
  const parts: string[] = [];
  const quoted: boolean[] = [];
  let pos = 0;
  while (pos < text.length) {
    pos = skipWhitespace(text, pos);
    const ident = readIdentifier(text, pos);
    if (!ident) break;
    parts.push(ident.value);
    quoted.push(ident.quoted);
    pos = skipWhitespace(text, ident.end);
    if (text[pos] !== ".") break;
    pos++;
  }
  if (parts.length === 0) return null;
  return { parts, quoted, end: pos, rest: text.slice(pos), done: text.slice(pos).trim() === "" };
}

function readIdentifier(text: string, start: number): { value: string; quoted: boolean; end: number } | null {
  const pos = skipWhitespace(text, start);
  const quote = text[pos];
  if (quote === '"' || quote === "`" || quote === "[") {
    const close = quote === "[" ? "]" : quote;
    let value = "";
    for (let i = pos + 1; i < text.length; i++) {
      if (text[i] === close) return { value, quoted: true, end: i + 1 };
      value += text[i];
    }
    return null;
  }
  const match = text.slice(pos).match(/^[A-Za-z_][\w$]*/);
  return match ? { value: match[0], quoted: false, end: pos + match[0].length } : null;
}

function skipWhitespace(text: string, pos: number): number {
  while (pos < text.length && /\s/.test(text[pos])) pos++;
  return pos;
}

function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function hasTopLevelKeyword(sql: string, keywords: string[]): boolean {
  return keywords.some((keyword) => findTopLevelKeyword(sql, keyword, 0) >= 0);
}

function firstTopLevelKeywordIndex(sql: string, keywords: string[], start: number): number {
  const indexes = keywords.map((keyword) => findTopLevelKeyword(sql, keyword, start)).filter((index) => index >= 0);
  return indexes.length ? Math.min(...indexes) : -1;
}

function findTopLevelKeyword(sql: string, keyword: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  const upperKeyword = keyword.toUpperCase();
  for (let i = start; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote || (quote === "]" && ch === "]")) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "[") {
      quote = "]";
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    if (sql.slice(i, i + keyword.length).toUpperCase() !== upperKeyword) continue;
    const before = i === 0 ? "" : sql[i - 1];
    const after = sql[i + keyword.length] ?? "";
    if (!isIdentifierChar(before) && !isIdentifierChar(after)) return i;
  }
  return -1;
}

function isIdentifierChar(ch: string): boolean {
  return /[\w$]/.test(ch);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check if all primary key columns are present in the result set columns.
 * Comparison is case-insensitive.
 */
export function allPrimaryKeysPresent(primaryKeys: string[], resultColumns: string[], analysis?: EditableQueryInfo): boolean {
  if (analysis && !analysis.selectStar) {
    const sourceColumns = new Set(analysis.columns.flatMap((column) => (column.sourceName ? [column.sourceName.toLowerCase()] : [])));
    return primaryKeys.every((pk) => sourceColumns.has(pk.toLowerCase()));
  }
  const colSet = new Set(resultColumns.map((c) => c.toLowerCase()));
  return primaryKeys.every((pk) => colSet.has(pk.toLowerCase()));
}

export function allEditableColumnsWriteable(analysis: EditableQueryInfo, resultColumns: string[]): boolean {
  if (analysis.selectStar) return true;
  const sourceByResult = new Map(analysis.columns.map((column) => [column.resultName.toLowerCase(), column]));
  return resultColumns.every((resultColumn) => {
    const source = sourceByResult.get(resultColumn.toLowerCase());
    return !!source;
  });
}

export function sourceColumnsForResult(analysis: EditableQueryInfo, resultColumns: string[]): Array<string | undefined> | undefined {
  if (analysis.selectStar) return undefined;
  const sourceByResult = new Map(analysis.columns.map((column) => [column.resultName.toLowerCase(), column]));
  const sourceColumns = resultColumns.map((resultColumn) => sourceByResult.get(resultColumn.toLowerCase())?.sourceName);
  return resultColumns.every((resultColumn) => sourceByResult.has(resultColumn.toLowerCase())) ? sourceColumns : undefined;
}
