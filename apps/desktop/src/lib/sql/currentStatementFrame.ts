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
