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
  // Slightly generous vs CSS (0.85em font + 0.3em*2 padding + 0.35em margin) so the
  // statement frame does not clip past inlay hints.
  return Math.max(2, Math.ceil(label.length * 0.9 + 2.2));
}

export interface InlineHintForFrameWidth {
  from: number;
  column: string;
}

/** Document text columns plus inline widget hints that sit on `[lineFrom, lineTo)`. */
export function visualSqlColumnsWithInlineHints(text: string, lineFrom: number, lineTo: number, hints: readonly InlineHintForFrameWidth[] = []): number {
  let columns = visualSqlColumns(text);
  const seen = new Set<number>();
  for (const hint of hints) {
    if (hint.from < lineFrom || hint.from >= lineTo) continue;
    if (seen.has(hint.from)) continue;
    seen.add(hint.from);
    columns += estimateInlineHintVisualColumns(hint.column);
  }
  return columns;
}

/** Measure rendered line width in CSS pixels, including inline widgets already in the DOM. */
export function measureSqlLineWidthPx(view: { coordsAtPos: (pos: number, side?: -1 | 1) => { left: number; right: number; top: number; bottom: number } | null }, from: number, to: number): number | null {
  if (to < from) return null;
  const start = view.coordsAtPos(from, 1);
  const end = view.coordsAtPos(to, -1);
  if (!start || !end) return null;
  // Ignore cross-line measurements (wrapping / mismatched sides).
  if (Math.abs(start.top - end.top) > 2) return null;
  return Math.max(0, end.right - start.left);
}
