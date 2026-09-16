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
import { tokenizeRedisLine } from "@/lib/redis/redisCommandTokenizer";

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

/**
 * Build diagnostics for the whole editor source (multi-line). Each non-empty,
 * non-comment line is parsed as one Redis command.
 */
export function buildRedisSyntaxDiagnostics(source: string): SqlSemanticDiagnostic[] {
  const diagnostics: SqlSemanticDiagnostic[] = [];
  const lines = source.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex];
    const lineNo = lineIndex + 1; // 1-based line number for SqlTextSpan
    if (!rawLine || !rawLine.trim()) continue;
    // Skip comment-ish lines (Redis has no official comments, but `#`/`--` are
    // commonly used by users as notes).
    if (/^\s*(#|--)/.test(rawLine)) continue;

    const { argv, unclosedQuote, unclosedQuoteStart } = tokenizeRedisLine(rawLine);

    if (unclosedQuote) {
      const startCol = unclosedQuoteStart ?? 1;
      diagnostics.push({
        span: lineSpan(lineNo, startCol, Math.max(rawLine.length, startCol)),
        message: "Unclosed quote",
        severity: "error",
      });
      continue; // further checks are unreliable without a clean parse
    }

    if (argv.length === 0) continue;

    const upper = argv.map((token) => token.value.toUpperCase());
    const spec = resolveRedisCommandSpec(upper);
    const commandToken = argv[0];

    if (!spec) {
      diagnostics.push({
        span: lineSpan(lineNo, commandToken.startColumn, commandToken.endColumn),
        message: `Unknown command '${argv[0].value}'`,
        severity: "error",
      });
      continue;
    }

    if (!aritySatisfied(spec.arity, argv.length)) {
      diagnostics.push({
        span: lineSpan(lineNo, commandToken.startColumn, commandToken.endColumn),
        message: `Wrong number of arguments for '${argv[0].value}': expected ${describeArity(spec.arity)}, got ${argv.length - 1}`,
        severity: "error",
      });
      // Don't also emit a safety marker on the same token — arity error is clearer.
      continue;
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
  }

  return diagnostics;
}

/**
 * Gate diagnostics while the user is actively typing the command name on the
 * current line, to avoid transient "Unknown command" noise. Mirrors the intent
 * of `shouldRunSqlSemanticDiagnostics`.
 */
export function shouldRunRedisDiagnostics(source: string, cursor: number): boolean {
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
