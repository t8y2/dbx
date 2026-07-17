export type CellValue = string | number | boolean | null;

export function displayCellValue(value: CellValue): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function firstLineCellDisplayValue(value: string): string {
  const lineBreakIndex = value.search(/\r\n|\r|\n/);
  return lineBreakIndex === -1 ? value : value.slice(0, lineBreakIndex);
}
