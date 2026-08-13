export type CellValue = string | number | boolean | null;

export const DATA_GRID_CELL_DISPLAY_MAX_LENGTH = 256;
export const SQLSERVER_DATA_GRID_CELL_DISPLAY_MAX_LENGTH = 8_000;

export function displayCellValue(value: CellValue): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function firstLineCellDisplayValue(value: string): string {
  const lineBreakPattern = /\r\n|\r|\n/g;
  const firstLineBreak = lineBreakPattern.exec(value);
  if (!firstLineBreak) return value;

  const firstLine = value.slice(0, firstLineBreak.index);
  if (/\S/u.test(firstLine)) return firstLine;

  let lineStart = lineBreakPattern.lastIndex;

  while (lineStart <= value.length) {
    const lineBreak = lineBreakPattern.exec(value);
    const lineEnd = lineBreak?.index ?? value.length;
    const line = value.slice(lineStart, lineEnd);
    if (/\S/u.test(line)) return line;
    if (!lineBreak) return value;
    lineStart = lineBreakPattern.lastIndex;
  }

  return value;
}

export function limitDataGridCellDisplay(value: string, maxLength = DATA_GRID_CELL_DISPLAY_MAX_LENGTH): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}
