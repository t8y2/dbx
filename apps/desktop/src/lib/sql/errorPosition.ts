import type { DatabaseType, QueryResult } from "@/types/database";
import type { SqlParameterOptions } from "@/lib/sql/sqlParameters";
import { splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";
import { resultSourceRange } from "@/lib/tabs/tabPresentation";

export interface EditorErrorPosition {
  /** Absolute UTF-16 offset into the current editor document. */
  offset: number;
  /** 1-based line within the statement, for display. */
  line: number;
  /** 1-based column within the statement, for display. */
  column: number;
}

export interface SqlErrorOffsetOptions {
  editorSql: string;
  result: QueryResult | undefined | null;
  resultIndex?: number;
  databaseType?: DatabaseType;
  parameterOptions?: SqlParameterOptions;
}

/**
 * Diagnostics for the "locate SQL error" flow.
 *
 * Failures are always logged (they explain the "position unavailable" toast).
 * Successful resolutions are verbose-only: run
 * `localStorage.setItem("dbx:debug:sql-error-position", "1")` once (then reload)
 * to also inspect the drift/offset details.
 */
const LOG_TAG = "[DBX][sql-error-position]";
const DEBUG_FLAG_KEY = "dbx:debug:sql-error-position";

export function isSqlErrorPositionDebugEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(DEBUG_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

/** Emit a diagnostics record. Failures are always logged; success details are verbose-only. */
export function logSqlErrorPosition(stage: string, payload: Record<string, unknown>): void {
  console.info(`${LOG_TAG} ${stage}`, payload);
}

function previewText(value: string | undefined | null, max = 2000): string | undefined {
  if (value === undefined || value === null) return undefined;
  return value.length > max ? `${value.slice(0, max)}…(len=${value.length})` : value;
}

function logDiagnostics(stage: string, options: SqlErrorOffsetOptions, extra: Record<string, unknown>): void {
  const result = options.result ?? undefined;
  const details: Record<string, unknown> = {
    stage,
    resultIndex: options.resultIndex,
    editorLength: options.editorSql.length,
    result: result
      ? {
          statementIndex: result.statement_index,
          executionError: result.execution_error,
          hasError: Boolean(result.error),
          errorPosition: result.error?.errorPosition ?? null,
          sourceStatement: previewText(result.sourceStatement),
          executedStatement: previewText(result.executedStatement),
          sourceFrom: result.sourceFrom,
          sourceTo: result.sourceTo,
        }
      : null,
    editorSliceAtSourceRange: typeof result?.sourceFrom === "number" && typeof result?.sourceTo === "number" ? previewText(options.editorSql.slice(result.sourceFrom, result.sourceTo)) : undefined,
    editorContainsSourceStatement: result?.sourceStatement ? options.editorSql.includes(result.sourceStatement) : undefined,
    ...extra,
  };
  if (options.editorSql.trim()) {
    try {
      details.editorStatements = splitSqlStatementRanges(options.editorSql, options.databaseType, options.parameterOptions).map((statement, index) => ({
        index,
        from: statement.from,
        to: statement.to,
        sql: previewText(statement.sql, 200),
      }));
    } catch (error) {
      details.editorStatementSplitError = String(error);
    }
  }
  logSqlErrorPosition(stage, details);
}

/**
 * Translate a backend-reported SQL error position into an absolute offset in the
 * current editor document.
 *
 * The backend reports the position against the statement text it actually sent.
 * DBX frequently rewrites the user's statement before execution (pagination
 * wrappers, appended LIMIT/OFFSET, injected hidden key columns), so the position
 * is first resolved inside `executedStatement` and then projected back onto the
 * user's `sourceStatement` before it is placed in the editor.
 *
 * Returns `undefined` only when the result carries no position, or when
 * {@link resultSourceRange} cannot prove the result still maps to the same
 * statement text in the editor (stale editor / different statement) — jumping
 * anywhere in that case would be wrong.
 */
export function sqlErrorEditorOffset(options: SqlErrorOffsetOptions): EditorErrorPosition | undefined {
  const position = options.result?.error?.errorPosition;
  if (!position) {
    if (isSqlErrorPositionDebugEnabled()) logDiagnostics("skip:no-error-position", options, {});
    return undefined;
  }

  const range = resultSourceRange(options.editorSql, options.result ?? undefined, options.resultIndex, options.databaseType, options.parameterOptions);
  if (!range) {
    const reason = "resultSourceRange returned undefined: the result's statement text is not found (or no longer unique) in the editor";
    if (isSqlErrorPositionDebugEnabled()) {
      logDiagnostics("unresolved:result-source-range", options, { reason });
    } else {
      // Redacted failure record: SQL previews (user data) go to the debug-gated diagnostics only.
      logSqlErrorPosition("unresolved:result-source-range", { reason, resultIndex: options.resultIndex, statementIndex: options.result?.statement_index ?? null });
    }
    return undefined;
  }

  // The position is relative to the executed statement when we recorded one;
  // older/other results only have the source statement to fall back on.
  const executedStatement = options.result?.executedStatement;
  const positionBasis = executedStatement ?? range.sql;

  // Walk the line/column in the text the position is relative to (scalar values,
  // matching PostgreSQL's character-based cursor), then convert to UTF-16.
  const basisOffset = scalarPositionToUtf16Offset(positionBasis, position.line, position.column);
  const drifted = Boolean(executedStatement && executedStatement !== range.sql);
  const sourceOffset = drifted ? mapExecutedOffsetToSource(executedStatement!, range.sql, basisOffset) : basisOffset;

  // Clamp inside the resolved statement range so a residual mismatch can never
  // place the caret outside the statement it belongs to.
  const editorOffset = Math.max(range.from, Math.min(range.from + sourceOffset, range.to));
  if (isSqlErrorPositionDebugEnabled()) {
    logDiagnostics("resolved", options, {
      position,
      rangeFrom: range.from,
      rangeTo: range.to,
      rangeSql: previewText(range.sql),
      drifted,
      positionBasis: previewText(positionBasis),
      basisOffset,
      sourceOffset,
      editorOffset,
    });
  }
  return { offset: editorOffset, line: position.line, column: position.column };
}

/**
 * Convert a 1-based line/column counted in Unicode scalar values into a UTF-16
 * offset. Lines beyond the text are clamped to its end (the position is always
 * relative to `text`, so this only guards malformed/edge input).
 */
export function scalarPositionToUtf16Offset(text: string, line: number, column: number): number {
  const characters = Array.from(text);
  if (characters.length === 0) return 0;
  const targetLine = Math.max(1, line);
  const targetColumn = Math.max(1, column);

  let currentLine = 1;
  let lineStart = 0;
  let index = 0;
  while (index < characters.length && currentLine < targetLine) {
    if (characters[index] === "\n") {
      currentLine += 1;
      lineStart = index + 1;
    }
    index += 1;
  }
  if (currentLine < targetLine) return text.length;

  let lineEnd = characters.length;
  for (let cursor = lineStart; cursor < characters.length; cursor += 1) {
    if (characters[cursor] === "\n") {
      lineEnd = cursor;
      break;
    }
  }

  const target = Math.min(lineStart + (targetColumn - 1), lineEnd);
  return characters.slice(0, target).join("").length;
}

/**
 * Project a UTF-16 offset in the executed statement onto the original source
 * statement.
 *
 * 1. Pagination wraps (`SELECT * FROM (<sql>) …`) and appended clauses keep the
 *    original statement contiguous, so a direct substring search resolves them
 *    exactly.
 * 2. Injected columns (hidden keys) break contiguity: align the common prefix,
 *    then let the source resume where its remaining text next appears in the
 *    executed statement.
 * 3. Otherwise fall back to a single changed-region alignment between the first
 *    and last difference.
 */
export function mapExecutedOffsetToSource(executed: string, source: string, executedOffset: number): number {
  if (executed === source) return clamp(executedOffset, 0, source.length);
  const clampedExecuted = clamp(executedOffset, 0, executed.length);

  const direct = executed.indexOf(source);
  if (direct >= 0) return clamp(clampedExecuted - direct, 0, source.length);

  const prefix = commonPrefixLength(executed, source);
  const remainder = source.slice(prefix);
  if (remainder.length >= 2) {
    const resume = executed.indexOf(remainder, prefix);
    if (resume >= 0) {
      if (clampedExecuted < resume) return Math.min(clampedExecuted, prefix);
      return clamp(clampedExecuted - (resume - prefix), prefix, source.length);
    }
  }

  const suffix = commonSuffixLength(executed, source, prefix);
  const executedChangeEnd = executed.length - suffix;
  const sourceChangeEnd = source.length - suffix;
  if (clampedExecuted <= prefix) return clampedExecuted;
  if (clampedExecuted >= executedChangeEnd) {
    return clamp(clampedExecuted - (executedChangeEnd - sourceChangeEnd), prefix, sourceChangeEnd);
  }
  return prefix;
}

function commonPrefixLength(a: string, b: string): number {
  let index = 0;
  const max = Math.min(a.length, b.length);
  while (index < max && a[index] === b[index]) index += 1;
  return index;
}

function commonSuffixLength(a: string, b: string, prefix: number): number {
  let index = 0;
  const max = Math.min(a.length, b.length) - prefix;
  while (index < max && a[a.length - 1 - index] === b[b.length - 1 - index]) index += 1;
  return index;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(value, max));
}
