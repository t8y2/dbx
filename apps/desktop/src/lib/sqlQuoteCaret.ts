export interface SqlSingleQuoteCaretOptions {
  previousValue: string;
  nextValue: string;
  selectionStart: number | null | undefined;
}

export function insertedSqlSingleQuoteAtCaret(options: SqlSingleQuoteCaretOptions): boolean {
  const { previousValue, nextValue, selectionStart } = options;
  if (typeof selectionStart !== "number" || selectionStart < 1) return false;
  if (nextValue.charAt(selectionStart - 1) !== "'") return false;
  return nextValue.slice(0, selectionStart - 1) + nextValue.slice(selectionStart) === previousValue;
}

export function caretPositionInsideInsertedSqlSingleQuotes(options: SqlSingleQuoteCaretOptions): number | null {
  const { previousValue, nextValue, selectionStart } = options;
  if (typeof selectionStart !== "number" || selectionStart < 2) return null;
  if (nextValue.slice(selectionStart - 2, selectionStart) !== "''") return null;

  const singleQuoteInsertPrevious = nextValue.slice(0, selectionStart - 1) + nextValue.slice(selectionStart);
  if (singleQuoteInsertPrevious === previousValue) return selectionStart - 1;

  const pairInsertPrevious = nextValue.slice(0, selectionStart - 2) + nextValue.slice(selectionStart);
  if (pairInsertPrevious === previousValue) return selectionStart - 1;

  return null;
}
