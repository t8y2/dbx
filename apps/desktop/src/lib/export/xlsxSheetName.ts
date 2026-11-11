/** Excel limits a sheet name to 31 characters and forbids `[ ] : * ? / \`. */
export const XLSX_SHEET_NAME_MAX_LENGTH = 31;

const INVALID_XLSX_SHEET_NAME_CHARACTERS = /[[\]:*?/\\]/g;

/**
 * Cleans the user's fixed sheet name the way the workbook writers will:
 * forbidden characters become spaces and the result is trimmed and cut to
 * Excel's 31-character limit. An empty result means "no fixed name".
 */
export function normalizeXlsxSheetName(value: unknown): string {
  if (typeof value !== "string") return "";
  return [...value.replace(INVALID_XLSX_SHEET_NAME_CHARACTERS, " ").trim()].slice(0, XLSX_SHEET_NAME_MAX_LENGTH).join("").trim();
}

/** Sheet name for a single-sheet data export: the fixed name when one is set, otherwise the export's own default (a table name, result label, ...). */
export function xlsxDataSheetName(fixedName: string | undefined, defaultName: string): string {
  return normalizeXlsxSheetName(fixedName) || defaultName;
}

/** Value for a backend export request's `sheetName`: only xlsx exports carry it, and only when a fixed name is set. */
export function xlsxRequestSheetName(fixedName: string | undefined, format: string): string | undefined {
  return format === "xlsx" ? normalizeXlsxSheetName(fixedName) || undefined : undefined;
}
