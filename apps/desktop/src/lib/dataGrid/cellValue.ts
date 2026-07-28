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
  const lineBreakIndex = value.search(/\r\n|\r|\n/);
  return lineBreakIndex === -1 ? value : value.slice(0, lineBreakIndex);
}

export function limitDataGridCellDisplay(value: string, maxLength = DATA_GRID_CELL_DISPLAY_MAX_LENGTH): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}
