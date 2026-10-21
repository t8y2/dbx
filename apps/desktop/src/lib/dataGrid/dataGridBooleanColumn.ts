import type { DatabaseType } from "@/types/database";

export const BOOLEAN_CHECKBOX_SIZE = 13;
export const BOOLEAN_CELL_EDITOR_VALUES = ["true", "false"];

export const BOOLEAN_CELL_VALUE_STYLES = ["true-false", "zero-one"] as const;
/** How the grid renders a boolean cell's text. */
export type BooleanCellValueStyle = (typeof BOOLEAN_CELL_VALUE_STYLES)[number];
export const DEFAULT_BOOLEAN_CELL_VALUE_STYLE: BooleanCellValueStyle = "true-false";

export function normalizeBooleanCellValueStyle(value: unknown): BooleanCellValueStyle {
  return BOOLEAN_CELL_VALUE_STYLES.includes(value as BooleanCellValueStyle) ? (value as BooleanCellValueStyle) : DEFAULT_BOOLEAN_CELL_VALUE_STYLE;
}

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

export function isBooleanCellValue(value: unknown): boolean {
  return value === null || normalizeBooleanCellValue(value) !== null;
}

export function nextBooleanCellValue(current: unknown, nullable: boolean): boolean | null {
  const normalized = normalizeBooleanCellValue(current);
  if (normalized === true) return false;
  if (normalized === false) return nullable ? null : true;
  return true;
}

export function booleanCellEditorValue(value: unknown): string {
  const normalized = normalizeBooleanCellValue(value);
  if (normalized === true) return "true";
  if (normalized === false) return "false";
  return "";
}

/**
 * Text the grid shows for a boolean cell. `true-false` renders the uppercase
 * TRUE/FALSE form the display-options label advertises and that DBeaver/Navicat
 * use; `zero-one` matches the 1/0 form other database clients use for the same
 * column (#12187). Non-boolean values return `undefined` so callers can fall
 * through to the normal formatter.
 */
export function booleanCellDisplayText(value: unknown, style: BooleanCellValueStyle): string | undefined {
  if (typeof value !== "boolean") return undefined;
  if (style === "zero-one") return value ? "1" : "0";
  return value ? "TRUE" : "FALSE";
}

/** Labels for the boolean dropdown editor; stored values stay `true`/`false`. */
export function booleanCellEditorDisplayValues(style: BooleanCellValueStyle): string[] {
  return style === "zero-one" ? ["1", "0"] : ["TRUE", "FALSE"];
}

export function parseBooleanCellEditorValue(value: string | null): boolean | null | undefined {
  if (value === null) return null;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
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
