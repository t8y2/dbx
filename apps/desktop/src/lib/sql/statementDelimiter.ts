export interface StatementDelimiterDocument {
  readonly length: number;
  sliceString(from: number, to: number): string;
}

type StatementDelimiterSource = string | StatementDelimiterDocument;

export function trailingStatementDelimiterPosition(source: StatementDelimiterSource, rangeTo: number): number | null {
  let delimiterPos = rangeTo;
  let lineBreakCount = 0;
  while (delimiterPos < source.length) {
    const char = sliceSource(source, delimiterPos, delimiterPos + 1);
    if (!/\s/u.test(char)) break;
    if (char === "\n" && ++lineBreakCount > 1) return null;
    delimiterPos += 1;
  }
  return sliceSource(source, delimiterPos, delimiterPos + 1) === ";" ? delimiterPos : null;
}

export function cursorBelongsToTrailingStatementDelimiter(source: StatementDelimiterSource, rangeTo: number, cursorPos: number): boolean {
  if (cursorPos < rangeTo) return false;
  const delimiterPos = trailingStatementDelimiterPosition(source, rangeTo);
  if (delimiterPos === null) return false;
  if (cursorPos <= delimiterPos + 1) return true;

  const afterDelimiter = sliceSource(source, delimiterPos + 1, cursorPos);
  return !afterDelimiter.includes("\n") && afterDelimiter.trim() === "";
}

function sliceSource(source: StatementDelimiterSource, from: number, to: number): string {
  return typeof source === "string" ? source.slice(from, to) : source.sliceString(from, to);
}
