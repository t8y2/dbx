export const BOOLEAN_CHECKBOX_SIZE = 13;

export function isBooleanColumnType(dataType: string | undefined): boolean {
  if (!dataType) return false;
  const normalized = dataType.trim().toLowerCase();
  return normalized === "boolean" || normalized === "bool" || normalized === "bit" || normalized === "bit(1)";
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
