import { loadEngine } from "@/lib/sql/layout/internals";
import { formatterLanguageForDialect, type SqlFormatDialect } from "@/lib/sql/sqlFormatter";

/**
 * Re-casing SQL keywords in place, without touching identifiers.
 *
 * The toolbar's `a`/`A` button used to only flip the formatter preference, so
 * clicking it changed nothing on screen (issue #11828). It now converts the
 * text immediately *and* updates the preference, which means it needs a
 * keyword-only case conversion.
 *
 * `convertSqlSelectionCase` (the context menu's 转为大写/小写) cannot serve
 * here: it re-cases every non-protected word, so it also rewrites unquoted
 * identifiers — a semantic change on case-sensitive engines (PostgreSQL, MySQL
 * on Linux). "Keywords only" needs to know which words are keywords, and for a
 * multi-word clause the words are not independently classified: in
 * `select by from t group by by` the first `by` is a column while `group by`
 * is one keyword phrase.
 *
 * So classification comes from sql-formatter's own lexer, reached through the
 * `sql-formatter/dist/` alias in {@link loadEngine}. That is also what keeps
 * this in sync with the formatter: the token types below are exactly the ones
 * whose text `keywordCase` rewrites, so a click and a later 格式化 agree.
 */

/**
 * sql-formatter token types that follow `keywordCase`.
 *
 * `RESERVED_FUNCTION_NAME` and `RESERVED_DATA_TYPE` are deliberately absent:
 * the formatter re-cases those under `functionCase` / `dataTypeCase`, and the
 * toolbar button promises "keywords".
 */
const KEYWORD_TOKEN_TYPES = new Set(["RESERVED_SELECT", "RESERVED_CLAUSE", "RESERVED_SET_OPERATION", "RESERVED_JOIN", "RESERVED_KEYWORD", "RESERVED_KEYWORD_PHRASE", "ARRAY_KEYWORD", "CASE", "WHEN", "THEN", "ELSE", "END", "BETWEEN", "AND", "OR", "XOR", "LIMIT"]);

export interface SqlKeywordSpan {
  from: number;
  to: number;
}

export type SqlKeywordCaseMode = "upper" | "lower";

/**
 * PostgreSQL has no backtick identifiers, but users paste MySQL-style SQL into
 * a PostgreSQL editor. DBX's formatter options already treat complete backtick
 * spans as opaque so formatting survives that; the tokenizer needs the same
 * allowance or one pasted identifier would abort the whole scan.
 */
const POSTGRES_BACKTICK_PARAM_TYPES = { custom: [{ regex: "`(?:``|[^`])*`" }] };

/**
 * The keyword spans of `sql`, as offsets into that exact string, in order.
 *
 * Returns `null` — never a partial list — when this input cannot be classified:
 * a non-SQL dialect (Cypher), sql-formatter internals unavailable, or an input
 * the lexer rejects (an unclosed string, i.e. mid-typing). Callers leave the
 * text alone on `null`; guessing is what could rewrite an identifier.
 */
export async function loadSqlKeywordSpans(sql: string, dialect: SqlFormatDialect): Promise<SqlKeywordSpan[] | null> {
  if (!sql.trim()) return [];
  const language = formatterLanguageForDialect(dialect);
  if (!language) return null;

  const engine = await loadEngine();
  if (!engine) return null;

  const dialectOptions = engine.dialects[language] ?? engine.dialects.sql;
  if (!dialectOptions) return null;

  const paramTypes = language === "postgresql" ? POSTGRES_BACKTICK_PARAM_TYPES : {};
  let tokens;
  try {
    tokens = engine.createDialect(dialectOptions).tokenizer.tokenize(sql, paramTypes);
  } catch {
    return null;
  }

  const spans: SqlKeywordSpan[] = [];
  for (const token of tokens) {
    if (!KEYWORD_TOKEN_TYPES.has(token.type as string)) continue;
    // `raw` is verbatim source, so a phrase that spans a line break still
    // slices back to exactly those characters.
    spans.push({ from: token.start, to: token.start + token.raw.length });
  }
  return spans;
}

/**
 * Re-cases the keyword `spans` intersecting `[from, to)`, copying every other
 * byte through untouched.
 *
 * `spans` come from {@link loadSqlKeywordSpans} for the same document text, so
 * this stays a pure slice-and-join with no re-tokenizing. Returns the converted
 * slice, or that slice unchanged when no keyword actually differs in case.
 */
export function applySqlKeywordCase(sql: string, range: { from: number; to: number }, mode: SqlKeywordCaseMode, spans: readonly SqlKeywordSpan[]): string {
  const from = Math.max(0, Math.min(range.from, sql.length));
  const to = Math.max(from, Math.min(range.to, sql.length));

  let converted = "";
  let cursor = from;
  let changed = false;
  for (const span of spans) {
    const start = Math.max(from, span.from);
    const end = Math.min(to, span.to);
    if (end <= start) continue;
    converted += sql.slice(cursor, start);
    const text = sql.slice(start, end);
    const replacement = mode === "upper" ? text.toUpperCase() : text.toLowerCase();
    if (replacement !== text) changed = true;
    converted += replacement;
    cursor = end;
  }

  if (!changed) return sql.slice(from, to);
  converted += sql.slice(cursor, to);
  return converted;
}
