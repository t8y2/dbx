import type { SqlTextRange } from "@/lib/sql/sqlStatementRanges";

export function currentStatementFrameRangeTo(nextChar: string, range: SqlTextRange): number {
  return nextChar === ";" ? range.to + 1 : range.to;
}

export function visualSqlColumns(text: string): number {
  let columns = 0;
  for (const ch of text) {
    if (ch === "\t") {
      columns += 4;
    } else if (isWideSqlChar(ch)) {
      columns += 2;
    } else {
      columns += 1;
    }
  }
  return columns;
}

export function isWideSqlChar(ch: string): boolean {
  return /[\u1100-\u115f\u2329\u232a\u2e80-\u303e\u3040-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(ch);
}

/** Approximate visual columns for a `.cm-insert-value-hint` widget (0.85em text + padding/margin). */
export function estimateInlineHintVisualColumns(label: string): number {
  // font-size 0.85em, padding 0 0.3em, margin-right 0.35em ≈ 0.95em chrome
  return Math.max(1, Math.ceil(label.length * 0.85 + 0.95));
}

export interface InlineHintForFrameWidth {
  from: number;
  column: string;
}

/** Document text columns plus inline widget hints that sit on `[lineFrom, lineTo)`. */
export function visualSqlColumnsWithInlineHints(text: string, lineFrom: number, lineTo: number, hints: readonly InlineHintForFrameWidth[] = []): number {
  let columns = visualSqlColumns(text);
  for (const hint of hints) {
    if (hint.from >= lineFrom && hint.from < lineTo) {
      columns += estimateInlineHintVisualColumns(hint.column);
    }
  }
  return columns;
}
