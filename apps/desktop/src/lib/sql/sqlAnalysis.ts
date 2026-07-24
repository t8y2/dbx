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
  catalog?: string;
  catalogQuoted?: boolean;
  schema: string | undefined;
  schemaQuoted?: boolean;
  tableName: string;
  tableNameQuoted?: boolean;
  tableAlias?: string;
  selectStar: boolean;
  columns: EditableQueryColumn[]; // empty array if SELECT *
  sources?: EditableQuerySource[];
  editableSourceKey?: string;
  multiSource?: boolean;
  allowInsert?: boolean;
  allowInsertDelete?: boolean;
  distinct?: boolean;
}

export interface EditableQueryColumn {
  sourceName?: string;
  sourceNameQuoted?: boolean;
  sourceQualifier?: string;
  sourceKey?: string;
  star?: boolean;
  resultName: string;
  expression: string;
}

export interface EditableQuerySource {
  key: string;
  catalog?: string;
  catalogQuoted?: boolean;
  schema?: string;
  schemaQuoted?: boolean;
  tableName: string;
  tableNameQuoted?: boolean;
  alias?: string;
}

const POSTGRES_FOLDED_IDENTIFIER_TYPES = new Set(["postgres", "redshift", "gaussdb", "highgo", "vastbase", "kwdb", "opengauss", "questdb"]);
const ORACLE_FOLDED_IDENTIFIER_TYPES = new Set(["oracle", "dameng", "oceanbase-oracle"]);

/**
 * Resolve a SQL source identifier to the canonical name returned by table
 * metadata. Quoted identifiers are always exact. PostgreSQL-compatible
 * unquoted identifiers fold to lower case, while Oracle-compatible identifiers
 * fold to upper case. Other dialects may use a case-insensitive match only when
 * it identifies exactly one physical column.
 */
export function resolveMetadataColumnName(databaseType: string, sourceName: string, sourceNameQuoted: boolean | undefined, metadataColumns: readonly string[]): string | undefined {
  if (sourceNameQuoted) return metadataColumns.find((column) => column === sourceName);

  // Result-set labels are already database-resolved names rather than SQL
  // source tokens. Preserve exact PostgreSQL/Oracle casing instead of folding
  // a physical quoted column such as `"ID"` to `id`.
  if (sourceNameQuoted === undefined) {
    const exact = metadataColumns.find((column) => column === sourceName);
    if (exact || POSTGRES_FOLDED_IDENTIFIER_TYPES.has(databaseType) || ORACLE_FOLDED_IDENTIFIER_TYPES.has(databaseType)) return exact;
    const caseOnlyMatches = metadataColumns.filter((column) => column.toLowerCase() === sourceName.toLowerCase());
    return caseOnlyMatches.length === 1 ? caseOnlyMatches[0] : undefined;
  }

  if (POSTGRES_FOLDED_IDENTIFIER_TYPES.has(databaseType)) {
    const folded = sourceName.toLowerCase();
    return metadataColumns.find((column) => column === folded);
  }
  if (ORACLE_FOLDED_IDENTIFIER_TYPES.has(databaseType)) {
    const folded = sourceName.toUpperCase();
    return metadataColumns.find((column) => column === folded);
  }

  const exact = metadataColumns.find((column) => column === sourceName);
  if (exact) return exact;
  const caseOnlyMatches = metadataColumns.filter((column) => column.toLowerCase() === sourceName.toLowerCase());
  return caseOnlyMatches.length === 1 ? caseOnlyMatches[0] : undefined;
}

export type QueryEditabilityReason = "not-select" | "cte" | "set-operation" | "aggregation" | "external-source" | "complex-source" | "computed-columns" | "no-table" | "no-primary-key" | "primary-key-not-returned" | "aliased-columns" | "metadata-unavailable";

export type QueryEditability = { editable: true; analysis: EditableQueryInfo } | { editable: false; reason: QueryEditabilityReason };

/**
 * Parse a SELECT statement to determine if it's editable.
 * Parse a SELECT statement to determine whether DBX can bind result columns to
 * base-table columns. DBeaver uses result metadata for the same idea; DBX has to
 * recover enough source mapping from SQL text before table metadata is loaded.
 *
 * Aggregated/set/query-derived results remain read-only. Multi-source queries
 * may still be editable later if metadata proves that exactly one source table
 * has a complete row identifier in the returned columns.
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

  const rawSelectBody = normalized.slice("SELECT".length, fromIndex).trim();
  const distinct = /^DISTINCT\b/i.test(rawSelectBody);
  const selectBodyWithoutDistinct = distinct ? rawSelectBody.replace(/^DISTINCT\b/i, "").trimStart() : rawSelectBody;
  // DISTINCT ON selects a representative row using database-specific ordering,
  // so it cannot be mapped to base rows like an ordinary DISTINCT projection.
  if (distinct && /^ON\b/i.test(selectBodyWithoutDistinct)) return { editable: false, reason: "aggregation" };
  const selectBody = stripSqlServerTopClause(selectBodyWithoutDistinct);

  const groupIndex = findTopLevelKeyword(normalized, "GROUP", fromIndex + 4);
  const havingIndex = findTopLevelKeyword(normalized, "HAVING", fromIndex + 4);
  if (groupIndex >= 0 || havingIndex >= 0) return { editable: false, reason: "aggregation" };

  const forIndex = findTopLevelKeyword(normalized, "FOR", fromIndex + 4);
  // Row-locking FOR clauses change concurrency behavior, not the base-row
  // mapping. Output/read-only FOR modes must stay non-editable.
  if (forIndex >= 0 && !/^FOR\s+(?:UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i.test(normalized.slice(forIndex))) return { editable: false, reason: "complex-source" };
  const fromEnd = firstTopLevelKeywordIndex(normalized, ["WHERE", "ORDER", "LIMIT", "OFFSET", "FETCH", "FOR"], fromIndex + 4);
  const fromBody = normalized.slice(fromIndex + 4, fromEnd < 0 ? normalized.length : fromEnd).trim();
  if (isExternalFromSource(fromBody)) return { editable: false, reason: "external-source" };
  const sources = parseFromSources(fromBody);
  if (!sources.length) return { editable: false, reason: "complex-source" };
  const source = sources[0]!;

  const selectStar = sources.length === 1 && isSelectStar(selectBody, source.alias);
  const columns = selectStar ? [] : parseSelectColumns(selectBody, sources);
  if (!selectStar && columns.length === 0) return { editable: false, reason: "computed-columns" };
  if (sources.length > 1 && columns.some((column) => column.star && !column.sourceKey)) {
    return { editable: false, reason: "complex-source" };
  }

  const analysis: EditableQueryInfo = {
    catalog: source.catalog,
    catalogQuoted: source.catalogQuoted,
    schema: source.schema,
    schemaQuoted: source.schemaQuoted,
    tableName: source.tableName,
    tableNameQuoted: source.tableNameQuoted,
    tableAlias: source.alias,
    selectStar,
    columns,
    ...(distinct ? { distinct: true, allowInsertDelete: false } : {}),
  };
  if (sources.length > 1) {
    analysis.sources = sources;
    analysis.multiSource = true;
    analysis.allowInsertDelete = false;
  }
  return {
    editable: true,
    analysis,
  };
}

export function queryEditabilityMessageKey(reason: QueryEditabilityReason): string {
  return `grid.queryEditUnsupported.${reason}`;
}

function stripSqlServerTopClause(body: string): string {
  const topMatch = body.match(/^TOP(?:\s+|(?=\())(?:\((?:[^()'"`[\]]|"[^"]*"|'(?:''|[^'])*'|`[^`]*`|\[[^\]]*\])+\)|\d+)\s*/i);
  if (!topMatch) return body;
  let remaining = body.slice(topMatch[0].length).trimStart();
  remaining = remaining.replace(/^PERCENT\b\s*/i, "").replace(/^WITH\s+TIES\b\s*/i, "");
  return remaining || body;
}

function parseSelectColumns(body: string, sources?: EditableQuerySource[]): EditableQueryColumn[] {
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
      const col = parseSelectColumn(current.trim(), sources);
      if (!col) return [];
      cols.push(col);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    const col = parseSelectColumn(current.trim(), sources);
    if (!col) return [];
    cols.push(col);
  }
  return cols;
}

function parseSelectColumn(col: string, sources?: EditableQuerySource[]): EditableQueryColumn | null {
  const star = parseStarSelectColumn(col, sources);
  if (star) return star;
  const source = parseQualifiedIdentifier(col);
  if (!source) return parseComputedSelectColumn(col);
  const alias = parseColumnAlias(source.rest);
  if (alias === null) return parseComputedSelectColumn(col);
  const sourceName = source.parts[source.parts.length - 1];
  const qualifier = source.parts.length >= 2 ? source.parts[source.parts.length - 2] : undefined;
  const sourceKey = qualifier ? sourceKeyForQualifier(sources, qualifier) : undefined;
  return {
    sourceName,
    sourceNameQuoted: source.quoted[source.quoted.length - 1],
    ...(qualifier ? { sourceQualifier: qualifier } : {}),
    ...(sourceKey ? { sourceKey } : {}),
    resultName: alias ?? sourceName,
    expression: col.slice(0, source.end).trim(),
  };
}

function parseStarSelectColumn(col: string, sources?: EditableQuerySource[]): EditableQueryColumn | null {
  if (col === "*") {
    return {
      star: true,
      resultName: "*",
      expression: col,
    };
  }
  const starMatch = col.match(/^((?:[A-Za-z_][\w$]*|"[^"]+"|`[^`]+`|\[[^\]]+\]))\s*\.\s*\*$/);
  if (!starMatch) return null;
  const qualifier = readIdentifier(starMatch[1]!, 0);
  if (!qualifier) return null;
  const sourceKey = sourceKeyForQualifier(sources, qualifier.value);
  return {
    star: true,
    sourceQualifier: qualifier.value,
    ...(sourceKey ? { sourceKey } : {}),
    resultName: "*",
    expression: col,
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

function parseFromSources(body: string): EditableQuerySource[] {
  if (!body || /[()]/.test(body)) return [];
  const sources: EditableQuerySource[] = [];
  let pos = 0;
  const first = parseTableSourceAt(body, pos, sources.length);
  if (!first) return [];
  sources.push(first.source);
  pos = first.end;

  while (pos < body.length) {
    pos = skipWhitespace(body, pos);
    if (pos >= body.length) break;
    if (body[pos] === ",") {
      const next = parseTableSourceAt(body, pos + 1, sources.length);
      if (!next) return [];
      sources.push(next.source);
      pos = next.end;
      continue;
    }
    const joinIndex = findTopLevelKeyword(body, "JOIN", pos);
    if (joinIndex < 0) break;
    const next = parseTableSourceAt(body, joinIndex + "JOIN".length, sources.length);
    if (!next) return [];
    sources.push(next.source);
    pos = next.end;
  }

  return sources;
}

function parseTableSourceAt(text: string, start: number, index: number): { source: EditableQuerySource; end: number } | null {
  const pos = skipWhitespace(text, start);
  if (text[pos] === "'" || text[pos] === "(") return null;
  const ident = parseQualifiedIdentifier(text.slice(pos));
  if (!ident || ident.parts.length < 1 || ident.parts.length > 3) return null;
  if (ident.rest.trimStart().startsWith("(")) return null;

  let end = pos + ident.end;
  let alias: string | undefined;
  let tailPos = skipWhitespace(text, end);
  if (startsWithKeyword(text, tailPos, "AS")) {
    const aliasIdent = readIdentifier(text, tailPos + 2);
    if (!aliasIdent) return null;
    alias = aliasIdent.value;
    end = aliasIdent.end;
    tailPos = skipWhitespace(text, end);
  } else if (!tableSourceTerminatorAt(text, tailPos)) {
    const aliasIdent = readIdentifier(text, tailPos);
    if (!aliasIdent) return null;
    alias = aliasIdent.value;
    end = aliasIdent.end;
  }

  const tableName = ident.parts[ident.parts.length - 1]!;
  const tableNameQuoted = ident.quoted[ident.quoted.length - 1];
  const schema = ident.parts.length >= 2 ? ident.parts[ident.parts.length - 2] : undefined;
  const schemaQuoted = ident.parts.length >= 2 ? ident.quoted[ident.quoted.length - 2] : false;
  const catalog = ident.parts.length === 3 ? ident.parts[0] : undefined;
  const catalogQuoted = ident.parts.length === 3 ? ident.quoted[0] : false;
  return {
    source: {
      key: `${alias ?? tableName}:${index}`,
      ...(catalog ? { catalog, catalogQuoted } : {}),
      schema,
      schemaQuoted,
      tableName,
      tableNameQuoted,
      alias,
    },
    end,
  };
}

function isExternalFromSource(body: string): boolean {
  const trimmed = body.trim();
  return /^'(?:''|[^'])*'(?:\s+(?:AS\s+)?[A-Za-z_][\w$]*)?$/i.test(trimmed) || /^[A-Za-z_][\w$]*\s*\(/.test(trimmed);
}

function tableSourceTerminatorAt(text: string, pos: number): boolean {
  if (pos >= text.length) return true;
  if (text[pos] === ",") return true;
  return ["ON", "USING", "JOIN", "LEFT", "RIGHT", "INNER", "FULL", "CROSS", "OUTER", "NATURAL"].some((keyword) => startsWithKeyword(text, pos, keyword));
}

function startsWithKeyword(text: string, pos: number, keyword: string): boolean {
  const start = skipWhitespace(text, pos);
  if (text.slice(start, start + keyword.length).toUpperCase() !== keyword) return false;
  const before = start === 0 ? "" : text[start - 1];
  const after = text[start + keyword.length] ?? "";
  return !isIdentifierChar(before) && !isIdentifierChar(after);
}

function sourceKeyForQualifier(sources: EditableQuerySource[] | undefined, qualifier: string): string | undefined {
  if (!sources?.length) return undefined;
  const normalizedQualifier = qualifier.toLowerCase();
  const matches = sources.filter((source) => (source.alias ?? source.tableName).toLowerCase() === normalizedQualifier || source.tableName.toLowerCase() === normalizedQualifier);
  return matches.length === 1 ? matches[0]!.key : undefined;
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
 * Source names must already be resolved to canonical metadata names. Exact
 * comparison prevents `id` from being mistaken for a distinct quoted `"ID"`
 * column in PostgreSQL.
 */
export function allPrimaryKeysPresent(primaryKeys: string[], resultColumns: string[], analysis?: EditableQueryInfo, sourceKey?: string): boolean {
  if (analysis && !analysis.selectStar) {
    const sourceColumns = new Set(
      analysis.columns.flatMap((column) => {
        if (!column.sourceName) return [];
        if (sourceKey && column.sourceKey !== sourceKey) return [];
        return [column.sourceName];
      }),
    );
    return primaryKeys.every((pk) => sourceColumns.has(pk));
  }
  const colSet = new Set(resultColumns);
  return primaryKeys.every((pk) => colSet.has(pk));
}

function matchColumnsForResult(analysis: EditableQueryInfo, resultColumns: string[]): EditableQueryColumn[] | undefined {
  const matches: EditableQueryColumn[] = [];
  let searchFrom = 0;
  for (const resultColumn of resultColumns) {
    let matchIndex = analysis.columns.findIndex((column, index) => index >= searchFrom && column.resultName === resultColumn);
    if (matchIndex < 0) {
      const normalized = resultColumn.toLowerCase();
      const caseOnlyMatches = analysis.columns.flatMap((column, index) => (index >= searchFrom && column.resultName.toLowerCase() === normalized ? [index] : []));
      if (caseOnlyMatches.length === 1) matchIndex = caseOnlyMatches[0]!;
    }
    if (matchIndex < 0) return undefined;
    matches.push(analysis.columns[matchIndex]!);
    searchFrom = matchIndex + 1;
  }
  return matches;
}

export function allEditableColumnsWriteable(analysis: EditableQueryInfo, resultColumns: string[], sourceKey?: string): boolean {
  if (analysis.selectStar) return true;
  const matchedColumns = matchColumnsForResult(analysis, resultColumns);
  return !!matchedColumns && matchedColumns.every((source) => !sourceKey || !source.sourceName || source.sourceKey === sourceKey);
}

export function sourceColumnsForResult(analysis: EditableQueryInfo, resultColumns: string[], sourceKey?: string): Array<string | undefined> | undefined {
  if (analysis.selectStar) return undefined;
  const matchedColumns = matchColumnsForResult(analysis, resultColumns);
  if (!matchedColumns) return undefined;
  return matchedColumns.map((column) => {
    if (sourceKey && column.sourceKey !== sourceKey) return undefined;
    return column.sourceName;
  });
}
