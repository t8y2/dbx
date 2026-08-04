import type { DatabaseType } from "@/types/database";

export const BOOLEAN_CHECKBOX_SIZE = 13;

const MYSQL_BIT_BOOLEAN_DATABASE_TYPES = new Set<DatabaseType>(["mysql"]);

export function isBooleanColumnType(dataType: string | undefined, databaseType?: DatabaseType): boolean {
  if (!dataType) return false;
  const normalized = dataType.trim().toLowerCase();
  if (normalized === "boolean" || normalized === "bool") return true;
  if (databaseType === "sqlserver") return normalized === "bit";
  if (databaseType && MYSQL_BIT_BOOLEAN_DATABASE_TYPES.has(databaseType)) return normalized === "bit" || normalized === "bit(1)";
  return false;
}

export function normalizeBooleanCellValue(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "t" || normalized === "yes") return true;
    if (normalized === "false" || normalized === "0" || normalized === "f" || normalized === "no") return false;
    return null;
  }
  return null;
}

export function isBooleanCheckboxValue(value: unknown): boolean {
  return value === null || normalizeBooleanCellValue(value) !== null;
}

export function nextBooleanCellValue(current: unknown, nullable: boolean): boolean | null {
  const normalized = normalizeBooleanCellValue(current);
  if (normalized === true) return false;
  if (normalized === false) return nullable ? null : true;
  return true;
}

export function booleanCheckboxRect(cell: { left: number; top: number; width: number; height: number }): { left: number; top: number; size: number } {
  return {
    left: cell.left + (cell.width - BOOLEAN_CHECKBOX_SIZE) / 2,
    top: cell.top + (cell.height - BOOLEAN_CHECKBOX_SIZE) / 2,
    size: BOOLEAN_CHECKBOX_SIZE,
  };
}

export function isPointInBooleanCheckbox(point: { x: number; y: number }, cell: { left: number; top: number; width: number; height: number }): boolean {
  const rect = booleanCheckboxRect(cell);
  return point.x >= rect.left && point.x <= rect.left + rect.size && point.y >= rect.top && point.y <= rect.top + rect.size;
}
