/**
 * Redis command syntax diagnostics for the query editor.
 *
 * Mirrors the shape of `sqlSemantic/diagnostics.ts` so the editor's diagnostic
 * pipeline (StateField + Decoration.mark) can render them with no extra wiring.
 * Diagnostics are produced per-line (one Redis command per line — matching the
 * execution contract in `queryStore.executeTabSql`).
 */
import type { SqlTextSpan } from "@/types/database";
import type { SqlSemanticDiagnostic } from "@/lib/sql/semantic/diagnostics";
import { resolveRedisCommandSpec } from "@/lib/redis/redisCommandTable";
import { isRedisCommentLine, tokenizeRedisLine } from "@/lib/redis/redisCommandTokenizer";

export { tokenizeRedisLine, type RedisArgvResult, type RedisArgvToken } from "@/lib/redis/redisCommandTokenizer";

function aritySatisfied(arity: number, tokenCount: number): boolean {
  if (arity > 0) return tokenCount === arity;
  if (arity < 0) return tokenCount >= -arity;
  return true; // arity 0 — unspecified, accept anything
}

function describeArity(arity: number): string {
  if (arity > 0) return `exactly ${arity - 1} argument${arity - 1 === 1 ? "" : "s"}`;
  if (arity < 0) return `at least ${-arity - 1} argument${-arity - 1 === 1 ? "" : "s"}`;
  return "any number of arguments";
}

function lineSpan(lineIndex: number, startColumn: number, endColumn: number): SqlTextSpan {
  // SqlTextSpan columns are 1-based and inclusive; map onto the physical line.
  return {
    start_line: lineIndex,
    start_column: startColumn,
    end_line: lineIndex,
    end_column: endColumn,
  };
}

export interface RedisLineRange {
  startLine: number;
  endLine: number;
}

export type RedisDiagnosticSource = string | { lines: number; line(n: number): { text: string } };

/**
 * Build diagnostics for editor source (multi-line). Each non-empty,
 * non-comment line is parsed as one Redis command. When lineRanges is
 * provided, only lines intersecting those ranges are analyzed.
 */
export function buildRedisSyntaxDiagnostics(source: RedisDiagnosticSource, lineRanges?: readonly RedisLineRange[]): SqlSemanticDiagnostic[] {
  const diagnostics: SqlSemanticDiagnostic[] = [];
  const isDoc = typeof source !== "string";
  const lineCount = isDoc ? source.lines : 0;
  const lines = isDoc ? undefined : source.split(/\r?\n/);
  const totalLines = isDoc ? lineCount : lines!.length;

  const checkLine = (lineNo: number, rawLine: string) => {
    if (!rawLine || !rawLine.trim()) return;
    if (isRedisCommentLine(rawLine)) return;

    const { argv, unclosedQuote, unclosedQuoteStart } = tokenizeRedisLine(rawLine);

    if (unclosedQuote) {
      const startCol = unclosedQuoteStart ?? 1;
      diagnostics.push({
        span: lineSpan(lineNo, startCol, Math.max(rawLine.length, startCol)),
        message: "Unclosed quote",
        severity: "error",
      });
      return;
    }

    if (argv.length === 0) return;

    const upper = argv.map((token) => token.value.toUpperCase());
    const spec = resolveRedisCommandSpec(upper);
    const commandToken = argv[0];

    if (!spec) {
      diagnostics.push({
        span: lineSpan(lineNo, commandToken.startColumn, commandToken.endColumn),
        message: `Unknown command '${argv[0].value}'`,
        severity: "error",
      });
      return;
    }

    if (!aritySatisfied(spec.arity, argv.length)) {
      diagnostics.push({
        span: lineSpan(lineNo, commandToken.startColumn, commandToken.endColumn),
        message: `Wrong number of arguments for '${argv[0].value}': expected ${describeArity(spec.arity)}, got ${argv.length - 1}`,
        severity: "error",
      });
      return;
    }

    if (spec.safety === "blocked") {
      diagnostics.push({
        span: lineSpan(lineNo, commandToken.startColumn, commandToken.endColumn),
        message: `Blocked command '${argv[0].value}'`,
        severity: "error",
      });
    } else if (spec.safety === "confirm") {
      diagnostics.push({
        span: lineSpan(lineNo, commandToken.startColumn, commandToken.endColumn),
        message: `Dangerous command '${argv[0].value}' — confirmation recommended`,
        severity: "warning",
      });
    }
  };

  const getLine = (lineNo: number): string => {
    if (isDoc) {
      return source.line(lineNo).text;
    }
    return lines![lineNo - 1] ?? "";
  };

  if (lineRanges && lineRanges.length > 0) {
    const checked = new Set<number>();
    for (const range of lineRanges) {
      const start = Math.max(1, range.startLine);
      const end = Math.min(totalLines, range.endLine);
      for (let lineNo = start; lineNo <= end; lineNo++) {
        if (checked.has(lineNo)) continue;
        checked.add(lineNo);
        checkLine(lineNo, getLine(lineNo));
      }
    }
  } else {
    for (let lineNo = 1; lineNo <= totalLines; lineNo++) {
      checkLine(lineNo, getLine(lineNo));
    }
  }

  return diagnostics;
}

/**
 * Gate diagnostics while the user is actively typing the command name on the
 * current line, to avoid transient "Unknown command" noise. Mirrors the intent
 * of `shouldRunSqlSemanticDiagnostics`.
 */
export function shouldRunRedisDiagnostics(source: string | { lineAt(pos: number): { text: string; from: number }; length: number }, cursor: number): boolean {
  if (typeof source !== "string") {
    if (source.length === 0) return false;
    const clampedPos = Math.max(0, Math.min(cursor, source.length));
    const line = source.lineAt(clampedPos);
    const lineText = line.text.slice(0, clampedPos - line.from);
    const trimmed = lineText.trimStart();
    if (trimmed.length > 0 && !/\s/.test(trimmed)) return false;
    return true;
  }
  if (!source.trim()) return false;
  // Find the line the cursor is on.
  const upto = source.slice(0, cursor);
  const lineStart = upto.lastIndexOf("\n") + 1;
  const lineText = source.slice(lineStart, cursor);
  const trimmed = lineText.trimStart();
  // If the cursor line only has whitespace and a partial first token with no
  // separating whitespace yet, we're still typing the command name → wait.
  if (trimmed.length > 0 && !/\s/.test(trimmed)) return false;
  return true;
}
