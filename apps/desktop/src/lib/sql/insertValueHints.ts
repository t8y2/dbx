import { findActiveSqlStatementSpan, tokenizeSqlSemantic, tokenIsIdentifier, unquoteSqlSemanticIdentifier } from "@/lib/sql/semantic/tokens";
import type { SqlSemanticSpan, SqlSemanticToken } from "@/lib/sql/semantic/types";

export interface InsertValueHint {
  /** Document offset where the inlay widget is inserted (before the value expression). */
  from: number;
  column: string;
}

export interface InsertValuesClause {
  table: string;
  schema?: string;
  /** Explicit column list, or null when `INSERT INTO t VALUES` has no column list. */
  columns: string[] | null;
  /** For each VALUES row, start offsets of top-level value expressions. */
  rows: number[][];
  span: SqlSemanticSpan;
}

export interface ParseInsertValueHintsOptions {
  /** Resolve table columns when the INSERT has no explicit column list. */
  resolveTableColumns?: (table: string, schema?: string) => string[] | undefined;
}

function significantTokens(tokens: readonly SqlSemanticToken[]): SqlSemanticToken[] {
  return tokens.filter((item) => item.kind !== "comment");
}

function statementSpans(sql: string, tokens: readonly SqlSemanticToken[]): SqlSemanticSpan[] {
  const spans: SqlSemanticSpan[] = [];
  let start = 0;
  for (const item of tokens) {
    if (item.kind !== "punctuation" || item.text !== ";" || item.depth !== 0) continue;
    const span = trimSpan(sql, start, item.span.start);
    if (span.end > span.start) spans.push(span);
    start = item.span.end;
  }
  const last = trimSpan(sql, start, sql.length);
  if (last.end > last.start) spans.push(last);
  return spans;
}

function trimSpan(sql: string, start: number, end: number): SqlSemanticSpan {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(sql[from] ?? "")) from += 1;
  while (to > from && /\s/.test(sql[to - 1] ?? "")) to -= 1;
  return { start: from, end: to };
}

function tokensInSpan(tokens: readonly SqlSemanticToken[], span: SqlSemanticSpan): SqlSemanticToken[] {
  return tokens.filter((item) => item.span.end > span.start && item.span.start < span.end);
}

function findWordIndex(tokens: readonly SqlSemanticToken[], word: string, from = 0): number {
  const needle = word.toLowerCase();
  for (let index = from; index < tokens.length; index += 1) {
    const item = tokens[index];
    if (item?.kind === "word" && item.normalized === needle) return index;
  }
  return -1;
}

function readQualifiedName(tokens: readonly SqlSemanticToken[], startIndex: number): { name: string; schema?: string; nextIndex: number } | null {
  const first = tokens[startIndex];
  if (!tokenIsIdentifier(first)) return null;
  const parts = [unquoteSqlSemanticIdentifier(first)];
  let index = startIndex + 1;
  while (tokens[index]?.text === "." && tokenIsIdentifier(tokens[index + 1])) {
    parts.push(unquoteSqlSemanticIdentifier(tokens[index + 1]!));
    index += 2;
  }
  if (parts.length >= 2) {
    return { schema: parts[parts.length - 2], name: parts[parts.length - 1]!, nextIndex: index };
  }
  return { name: parts[0]!, nextIndex: index };
}

function parseColumnList(tokens: readonly SqlSemanticToken[], openIndex: number): { columns: string[]; nextIndex: number } | null {
  const open = tokens[openIndex];
  if (!open || open.text !== "(") return null;
  const columns: string[] = [];
  let index = openIndex + 1;
  while (index < tokens.length) {
    const item = tokens[index];
    if (!item) break;
    if (item.text === ")" && item.depth === open.depth) {
      return { columns, nextIndex: index + 1 };
    }
    if (tokenIsIdentifier(item) && item.depth === open.depth + 1) {
      columns.push(unquoteSqlSemanticIdentifier(item));
      index += 1;
      continue;
    }
    index += 1;
  }
  return { columns, nextIndex: index };
}

function valueStartsInRow(tokens: readonly SqlSemanticToken[], openIndex: number): { starts: number[]; nextIndex: number } | null {
  const open = tokens[openIndex];
  if (!open || open.text !== "(") return null;
  const contentDepth = open.depth + 1;
  const starts: number[] = [];
  let expectValue = true;
  let index = openIndex + 1;

  while (index < tokens.length) {
    const item = tokens[index];
    if (!item) break;
    if (item.text === ")" && item.depth === open.depth) {
      return { starts, nextIndex: index + 1 };
    }
    if (expectValue && item.depth === contentDepth) {
      starts.push(item.span.start);
      expectValue = false;
    }
    if (item.text === "," && item.depth === contentDepth) {
      expectValue = true;
    }
    index += 1;
  }
  return { starts, nextIndex: index };
}

function parseValuesRows(tokens: readonly SqlSemanticToken[], valuesIndex: number): number[][] {
  const rows: number[][] = [];
  let index = valuesIndex + 1;
  while (index < tokens.length) {
    const item = tokens[index];
    if (!item) break;
    if (item.kind === "word" && (item.normalized === "returning" || item.normalized === "on" || item.normalized === "select")) break;
    if (item.text === "(") {
      const row = valueStartsInRow(tokens, index);
      if (!row) break;
      if (row.starts.length > 0) rows.push(row.starts);
      index = row.nextIndex;
      continue;
    }
    if (item.text === ",") {
      index += 1;
      continue;
    }
    break;
  }
  return rows;
}

function parseInsertClause(tokens: readonly SqlSemanticToken[], span: SqlSemanticSpan): InsertValuesClause | null {
  const insertIndex = findWordIndex(tokens, "insert");
  if (insertIndex < 0) return null;
  const intoIndex = findWordIndex(tokens, "into", insertIndex + 1);
  if (intoIndex < 0) return null;

  const tableInfo = readQualifiedName(tokens, intoIndex + 1);
  if (!tableInfo) return null;

  let index = tableInfo.nextIndex;
  let columns: string[] | null = null;

  // Optional alias between table and column list / VALUES / SELECT
  if (tokenIsIdentifier(tokens[index]) && tokens[index]?.normalized !== "values" && tokens[index]?.normalized !== "select" && tokens[index]?.normalized !== "default") {
    const maybeAs = tokens[index];
    if (maybeAs?.normalized === "as" && tokenIsIdentifier(tokens[index + 1])) {
      index += 2;
    } else if (tokens[index]?.text !== "(") {
      index += 1;
    }
  }

  if (tokens[index]?.text === "(") {
    const columnList = parseColumnList(tokens, index);
    if (!columnList) return null;
    columns = columnList.columns;
    index = columnList.nextIndex;
  }

  const valuesIndex = findWordIndex(tokens, "values", index);
  const selectIndex = findWordIndex(tokens, "select", index);
  if (valuesIndex < 0) return null;
  if (selectIndex >= 0 && selectIndex < valuesIndex) return null;

  const rows = parseValuesRows(tokens, valuesIndex);
  if (rows.length === 0) return null;

  return {
    table: tableInfo.name,
    schema: tableInfo.schema,
    columns,
    rows,
    span,
  };
}

/** Parse all INSERT ... VALUES clauses in `sql` (multi-statement aware). */
export function parseInsertValuesClauses(sql: string): InsertValuesClause[] {
  if (!sql.trim()) return [];
  const allTokens = tokenizeSqlSemantic(sql);
  const spans = statementSpans(sql, allTokens);
  const clauses: InsertValuesClause[] = [];
  for (const span of spans) {
    const tokens = significantTokens(tokensInSpan(allTokens, span));
    const clause = parseInsertClause(tokens, span);
    if (clause) clauses.push(clause);
  }
  return clauses;
}

/** Build inlay hint positions from parsed clauses and optional table-column resolver. */
export function buildInsertValueHints(clauses: readonly InsertValuesClause[], options: ParseInsertValueHintsOptions = {}): InsertValueHint[] {
  const hints: InsertValueHint[] = [];
  for (const clause of clauses) {
    const columns = clause.columns ?? options.resolveTableColumns?.(clause.table, clause.schema);
    if (!columns || columns.length === 0) continue;
    for (const row of clause.rows) {
      const count = Math.min(row.length, columns.length);
      for (let index = 0; index < count; index += 1) {
        const from = row[index];
        const column = columns[index];
        if (from === undefined || !column) continue;
        hints.push({ from, column });
      }
    }
  }
  return hints;
}

/** Parse SQL and return insert-value inlay hints. */
export function parseInsertValueHints(sql: string, options: ParseInsertValueHintsOptions = {}): InsertValueHint[] {
  return buildInsertValueHints(parseInsertValuesClauses(sql), options);
}

/** True when the document still needs table metadata for at least one INSERT without a column list. */
export function insertValueHintsNeedTableColumns(sql: string): InsertValuesClause[] {
  return parseInsertValuesClauses(sql).filter((clause) => clause.columns === null);
}

/** Convenience: hints for the statement containing `cursor` only. */
export function parseInsertValueHintsAtCursor(sql: string, cursor: number, options: ParseInsertValueHintsOptions = {}): InsertValueHint[] {
  const tokens = tokenizeSqlSemantic(sql);
  const span = findActiveSqlStatementSpan(sql, tokens, cursor);
  const statementTokens = significantTokens(tokensInSpan(tokens, span));
  const clause = parseInsertClause(statementTokens, span);
  if (!clause) return [];
  return buildInsertValueHints([clause], options);
}
