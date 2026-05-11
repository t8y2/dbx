export type CellValue = string | number | boolean | null;

export function displayCellValue(value: CellValue): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
