import { findActiveSqlStatementSpan, matchDollarQuoteTag, tokenizeSqlSemantic, tokenIsIdentifier, unquoteSqlSemanticIdentifier } from "@/lib/sql/semantic/tokens";
import type { SqlSemanticSpan, SqlSemanticToken } from "@/lib/sql/semantic/types";

export interface InsertValueHint {
  /** Document offset where the inlay widget is inserted (before the value expression). */
  from: number;
  column: string;
}

export interface InsertValuesClause {
  table: string;
  schema?: string;
  /** Catalog/database qualifier for three-part names like OtherDb.dbo.Users. */
  database?: string;
  /** Explicit column list, or null when `INSERT INTO t VALUES` has no column list. */
  columns: string[] | null;
  /** For each VALUES row, start offsets of top-level value expressions. */
  rows: number[][];
  span: SqlSemanticSpan;
}

export interface ParseInsertValueHintsOptions {
  /** Resolve table columns when the INSERT has no explicit column list. */
  resolveTableColumns?: (table: string, schema?: string, database?: string) => string[] | undefined;
}

export interface TextRange {
  from: number;
  to: number;
}

function significantTokens(tokens: readonly SqlSemanticToken[]): SqlSemanticToken[] {
  return tokens.filter((item) => item.kind !== "comment");
}

function statementTokenGroups(sql: string, tokens: readonly SqlSemanticToken[]): Array<{ span: SqlSemanticSpan; tokens: SqlSemanticToken[] }> {
  const groups: Array<{ span: SqlSemanticSpan; tokens: SqlSemanticToken[] }> = [];
  let start = 0;
  let tokenStart = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const item = tokens[index]!;
    if (item.kind !== "punctuation" || item.text !== ";" || item.depth !== 0) continue;
    const span = trimSpan(sql, start, item.span.start);
    if (span.end > span.start) groups.push({ span, tokens: significantTokens(tokens.slice(tokenStart, index)) });
    start = item.span.end;
    tokenStart = index + 1;
  }
  const last = trimSpan(sql, start, sql.length);
  if (last.end > last.start) groups.push({ span: last, tokens: significantTokens(tokens.slice(tokenStart)) });
  return groups;
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

export function readQualifiedName(tokens: readonly SqlSemanticToken[], startIndex: number): { name: string; schema?: string; database?: string; nextIndex: number } | null {
  const first = tokens[startIndex];
  if (!tokenIsIdentifier(first)) return null;
  const parts = [unquoteSqlSemanticIdentifier(first)];
  let index = startIndex + 1;
  while (tokens[index]?.text === "." && tokenIsIdentifier(tokens[index + 1])) {
    parts.push(unquoteSqlSemanticIdentifier(tokens[index + 1]!));
    index += 2;
  }
  if (parts.length >= 3) {
    return {
      database: parts[parts.length - 3],
      schema: parts[parts.length - 2],
      name: parts[parts.length - 1]!,
      nextIndex: index,
    };
  }
  if (parts.length === 2) {
    return { schema: parts[0], name: parts[1]!, nextIndex: index };
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

  // SQL Server table hints appear between the target table and INSERT column list.
  if (tokens[index]?.normalized === "with" && tokens[index + 1]?.text === "(") {
    const hintList = parseColumnList(tokens, index + 1);
    if (!hintList) return null;
    index = hintList.nextIndex;
  }

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
    database: tableInfo.database,
    columns,
    rows,
    span,
  };
}

function shiftClause(clause: InsertValuesClause, offset: number): InsertValuesClause {
  if (offset === 0) return clause;
  return {
    ...clause,
    span: { start: clause.span.start + offset, end: clause.span.end + offset },
    rows: clause.rows.map((row) => row.map((from) => from + offset)),
  };
}

/**
 * Expand [from, to) to the nearest top-level statement window (quote/comment/dollar-quote aware).
 * Scans at most LOOKBACK bytes before `from` and LOOKAHEAD after `to` so large scripts do not pay
 * O(document) on every keystroke in the common case (many statements, none of them huge).
 *
 * This is a bounded, best-effort heuristic operating on a plain string -- it has no notion of a
 * live document or incremental parse state. It's the correct (only) choice for this module's
 * pure-string callers (parseInsertValuesClauses* and their tests), which have no live editor to
 * consult. Callers that *do* have a live CodeMirror `EditorState` should prefer
 * `sqlSyntaxTreeWindow.ts`'s `resolveStatementWindowFromSyntaxTree`, which resolves the same
 * question against CodeMirror's own incrementally-parsed SQL syntax tree instead of re-deriving
 * lexical state locally -- see that module's doc comment for why it's provably correct for every
 * boundary class below except one narrow, disclosed gap (dollar-quoted bodies). sqlCompletion.ts's
 * `getSqlLexicalContext`/`activeSqlCompletionStatementSpan` already do this, falling back to the
 * scanner below only when there's no live state to consult.
 *
 * The backward scan starts at an arbitrary document offset, so its lexical state (in a string? in
 * a comment? inside a dollar-quoted body? how deep in nested parens?) cannot simply be assumed
 * clean -- if the cursor sits more than LOOKBACK bytes into such a construct, that assumption is
 * wrong and the scan can find a bogus statement boundary (e.g. a ';' inside an unclosed string or
 * a dollar-quoted function body). `resolveStatementStart` mitigates this with a best-effort check
 * instead of blind trust: it widens the backward window until two consecutive scans agree on the
 * same boundary, or until it reaches the true start of the document (index 0), where the
 * clean-state assumption is always correct.
 *
 * IMPORTANT: "two scans agree" is a heuristic, not a proof, and it has a known false-positive.
 * When the content between the two scan-start points is lexically inert (no quote/comment/paren/
 * dollar-quote characters -- e.g. a long run of uniform "SELECT n;" statements), both scans
 * converge on the identical answer regardless of whether the true state entering that content is
 * actually clean or is deep inside some unclosed construct opened much earlier. Confirmed
 * reproduction: an unterminated string containing many repeated ';' characters, or a large run of
 * "SELECT n;" statements inside a PostgreSQL `$$ ... $$` function body, both fool the check. This
 * is not fixable with a smarter local heuristic -- the two situations are byte-for-byte
 * indistinguishable from a purely local scan; making the check stricter (e.g. requiring a
 * lexically-significant character in the widened margin) would also reject the common, entirely
 * legitimate case of many small statements with no punctuation, which is the primary case this
 * windowing scheme exists to keep fast. This is a deliberate, documented tradeoff of the
 * pure-string fallback, not an oversight -- see `packages/app-tests/insertValueHints.test.ts`'s
 * test documenting it, and `sqlSyntaxTreeWindow.ts` for the provably-correct path used whenever a
 * live `EditorState` is available (i.e. for every real user keystroke in the editor).
 *
 * `dialectId` defaults to "mysql" (matching semantic/tokens.ts's tokenizeSqlSemantic default) and
 * only affects how `#` is treated -- see stepLexState. Callers that know the active SQL dialect
 * should pass it through so window boundaries agree with tokenizeSqlSemantic's own tokenization.
 */
const STATEMENT_LOOKBACK = 32 * 1024;
const STATEMENT_LOOKAHEAD = 32 * 1024;
const MAX_STATEMENT_START_WIDENINGS = 12; // 32KB * 2^12 = 128MB before we give up widening

interface LexState {
  depth: number;
  inLineComment: boolean;
  inBlockComment: boolean;
  quote: string | null;
  dollarTag: string | null;
}

function isLexStateClean(state: LexState): boolean {
  return state.depth === 0 && !state.inLineComment && !state.inBlockComment && !state.quote && !state.dollarTag;
}

/**
 * Advances `state` past the token starting at `sql[index]` and returns the next index.
 * `dialectId` only affects `#`: MySQL-family dialects treat it as a line-comment starter, but
 * PostgreSQL (and dialects that don't special-case it) use `#`/`#>`/`#>>`/`#-` as operators --
 * see the matching dialect check in semantic/tokens.ts's tokenizeSqlSemantic.
 */
function stepLexState(sql: string, index: number, state: LexState, dialectId: string): number {
  const ch = sql[index] ?? "";
  const next = sql[index + 1] ?? "";

  if (state.inLineComment) {
    if (ch === "\n" || ch === "\r") state.inLineComment = false;
    return index + 1;
  }
  if (state.inBlockComment) {
    if (ch === "*" && next === "/") {
      state.inBlockComment = false;
      return index + 2;
    }
    return index + 1;
  }
  if (state.dollarTag) {
    if (sql.startsWith(state.dollarTag, index)) {
      const tagLength = state.dollarTag.length;
      state.dollarTag = null;
      return index + tagLength;
    }
    return index + 1;
  }
  if (state.quote) {
    // Backslash-escaping only applies to '...' and "...", matching getSqlLexicalContext's
    // scanner in sqlCompletion.ts -- backtick/bracket identifiers don't use it.
    if ((state.quote === "'" || state.quote === '"') && ch === "\\" && next) return index + 2;
    const closeCh = state.quote === "]" ? "]" : state.quote;
    if (ch === closeCh) {
      if (next === closeCh) return index + 2;
      state.quote = null;
    }
    return index + 1;
  }

  if (ch === "-" && next === "-") {
    state.inLineComment = true;
    return index + 2;
  }
  if (ch === "#" && dialectId === "mysql") {
    state.inLineComment = true;
    return index + 1;
  }
  if (ch === "/" && next === "*") {
    state.inBlockComment = true;
    return index + 2;
  }
  if (ch === "'" || ch === '"' || ch === "`") {
    state.quote = ch;
    return index + 1;
  }
  if (ch === "[") {
    state.quote = "]";
    return index + 1;
  }
  if (ch === "$") {
    const marker = matchDollarQuoteTag(sql, index);
    if (marker) {
      state.dollarTag = marker;
      return index + marker.length;
    }
    return index + 1;
  }
  if (ch === "(") {
    state.depth += 1;
    return index + 1;
  }
  if (ch === ")") {
    state.depth = Math.max(0, state.depth - 1);
    return index + 1;
  }
  return index + 1;
}

/**
 * Scans sql[from, hardStop) tracking the last top-level ';' strictly before `searchEndFrom` (when
 * `trackStart` is set) and the first top-level ';' at or after `searchEndFrom`. Starts from a copy
 * of `initialState` when given (for resuming a previous scan without re-walking the prefix it
 * already covered), otherwise from a known-clean state.
 */
function scanStatementBoundaries(sql: string, from: number, searchEndFrom: number, hardStop: number, trackStart: boolean, dialectId: string, initialState?: LexState): { start: number; startFound: boolean; end: number; endFound: boolean; finalState: LexState } {
  const state: LexState = initialState ? { ...initialState } : { depth: 0, inLineComment: false, inBlockComment: false, quote: null, dollarTag: null };
  let start = from;
  let startFound = false;
  let end = hardStop;
  let endFound = false;
  let index = from;

  while (index < hardStop) {
    if (sql[index] === ";" && isLexStateClean(state)) {
      if (index >= searchEndFrom) {
        end = index;
        endFound = true;
        break;
      }
      if (trackStart) {
        start = index + 1;
        startFound = true;
      }
    }
    index = stepLexState(sql, index, state, dialectId);
  }

  return { start, startFound, end, endFound, finalState: state };
}

/**
 * Finds the nearest top-level statement boundary at or before `pos`. Best-effort, not a proof --
 * see the "IMPORTANT" note in the module comment above for the known false-positive case.
 */
function resolveStatementStart(sql: string, pos: number, dialectId: string): number {
  let lookback = STATEMENT_LOOKBACK;
  let previousCandidate: number | null = null;

  for (let attempt = 0; attempt < MAX_STATEMENT_START_WIDENINGS; attempt += 1) {
    const scanFrom = Math.max(0, pos - lookback);
    const result = scanStatementBoundaries(sql, scanFrom, pos, pos, true, dialectId);
    if (scanFrom === 0) return result.start;
    if (result.startFound && result.start === previousCandidate) return result.start;
    previousCandidate = result.startFound ? result.start : null;
    lookback *= 2;
  }
  // Widening did not converge; ground at the true document start, where clean state is guaranteed.
  return scanStatementBoundaries(sql, 0, pos, pos, true, dialectId).start;
}

function computeSqlStatementWindow(sql: string, from: number, to: number, dialectId: string): TextRange {
  const safeFrom = Math.max(0, Math.min(from, sql.length));
  const safeTo = Math.max(safeFrom, Math.min(to, sql.length));
  const start = resolveStatementStart(sql, safeFrom, dialectId);

  // The forward end-search has no "unproven starting state" problem like resolveStatementStart --
  // it scans continuously from `start`, which is already verified clean, so it never needs to
  // second-guess itself. It just needs enough room: a single statement larger than one
  // STATEMENT_LOOKAHEAD (e.g. a huge multi-row INSERT) would otherwise be silently truncated at
  // an arbitrary hardStop instead of found. So on a miss, keep widening the lookahead and resume
  // scanning from where the previous pass stopped (carrying its LexState forward) rather than
  // rescanning from `start` -- common statements still cost one bounded scan; only a statement
  // that's actually larger than the lookahead pays for (and gets) a correct, wider one.
  let lookahead = STATEMENT_LOOKAHEAD;
  let hardStop = Math.min(sql.length, safeTo + lookahead);
  let result = scanStatementBoundaries(sql, start, safeTo, hardStop, false, dialectId);
  while (!result.endFound && hardStop < sql.length) {
    const resumeFrom = hardStop;
    lookahead *= 2;
    hardStop = Math.min(sql.length, safeTo + lookahead);
    result = scanStatementBoundaries(sql, resumeFrom, safeTo, hardStop, false, dialectId, result.finalState);
  }

  // result.end is always <= hardStop by construction (scanStatementBoundaries only reports an
  // index it actually visited, or defaults to hardStop itself).
  const trimmed = trimSpan(sql, start, result.end);
  return { from: trimmed.start, to: trimmed.end };
}

interface StatementWindowMemo {
  sql: string;
  from: number;
  to: number;
  dialectId: string;
  result: TextRange;
}

// Single-entry cache: within one keystroke, several completion helpers (suppressed-context check,
// active-statement-span lookup, ...) call this with the exact same (sql, from, to, dialectId).
// String equality here is content equality (JS `===` on strings), so this is safe for a pure
// function -- a cache hit is guaranteed to be the same answer, not a staleness risk.
let statementWindowMemo: StatementWindowMemo | null = null;

export function expandToSqlStatementWindow(sql: string, from: number, to: number, dialectId = "mysql"): TextRange {
  if (statementWindowMemo && statementWindowMemo.sql === sql && statementWindowMemo.from === from && statementWindowMemo.to === to && statementWindowMemo.dialectId === dialectId) {
    return statementWindowMemo.result;
  }
  const result = computeSqlStatementWindow(sql, from, to, dialectId);
  statementWindowMemo = { sql, from, to, dialectId, result };
  return result;
}

function mergeTextRanges(ranges: readonly TextRange[]): TextRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: TextRange[] = [{ ...sorted[0]! }];
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index]!;
    const last = merged[merged.length - 1]!;
    if (current.from <= last.to) {
      last.to = Math.max(last.to, current.to);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

/** Parse INSERT ... VALUES clauses only inside the given document ranges (expanded to statement windows). */
export function parseInsertValuesClausesInRanges(sql: string, ranges: readonly TextRange[]): InsertValuesClause[] {
  if (!sql.trim() || ranges.length === 0) return [];
  const windows = mergeTextRanges(ranges.map((range) => expandToSqlStatementWindow(sql, range.from, range.to)));
  const clauses: InsertValuesClause[] = [];
  for (const window of windows) {
    if (window.to <= window.from) continue;
    const slice = sql.slice(window.from, window.to);
    for (const clause of parseInsertValuesClauses(slice)) {
      clauses.push(shiftClause(clause, window.from));
    }
  }
  return clauses;
}

/** Parse all INSERT ... VALUES clauses in `sql` (multi-statement aware). Prefer ranged parsing for editors. */
export function parseInsertValuesClauses(sql: string, dialectId = "mysql"): InsertValuesClause[] {
  if (!sql.trim()) return [];
  const allTokens = tokenizeSqlSemantic(sql, dialectId);
  const clauses: InsertValuesClause[] = [];
  for (const { span, tokens } of statementTokenGroups(sql, allTokens)) {
    const clause = parseInsertClause(tokens, span);
    if (clause) clauses.push(clause);
  }
  return clauses;
}

/** Build inlay hint positions from parsed clauses and optional table-column resolver. */
export function buildInsertValueHints(clauses: readonly InsertValuesClause[], options: ParseInsertValueHintsOptions = {}): InsertValueHint[] {
  const hints: InsertValueHint[] = [];
  for (const clause of clauses) {
    const columns = clause.columns ?? options.resolveTableColumns?.(clause.table, clause.schema, clause.database);
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

/** Parse only the statements covering `ranges` and return insert-value inlay hints. */
export function parseInsertValueHintsInRanges(sql: string, ranges: readonly TextRange[], options: ParseInsertValueHintsOptions = {}): InsertValueHint[] {
  return buildInsertValueHints(parseInsertValuesClausesInRanges(sql, ranges), options);
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
