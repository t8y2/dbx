import type { SqlTextRange } from "@/lib/sql/sqlStatementRanges";
import { trailingStatementDelimiterPosition, type StatementDelimiterDocument } from "@/lib/sql/statementDelimiter";

export function currentStatementFrameRangeTo(doc: StatementDelimiterDocument, range: SqlTextRange): number {
  const delimiterPos = trailingStatementDelimiterPosition(doc, range.to);
  return delimiterPos === null ? range.to : delimiterPos + 1;
}
