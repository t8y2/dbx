export type GridCellValue = string | number | boolean | null;

export interface CellPosition {
  rowIndex: number;
  colIndex: number;
}

export interface CellSelectionRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export interface SelectionData {
  columns: string[];
  rows: GridCellValue[][];
}

export function normalizeSelectionRange(anchor: CellPosition, focus: CellPosition): CellSelectionRange {
  return {
    startRow: Math.min(anchor.rowIndex, focus.rowIndex),
    endRow: Math.max(anchor.rowIndex, focus.rowIndex),
    startCol: Math.min(anchor.colIndex, focus.colIndex),
    endCol: Math.max(anchor.colIndex, focus.colIndex),
  };
}

export function isCellInSelection(rowIndex: number, colIndex: number, range: CellSelectionRange | null): boolean {
  if (!range) return false;
  return (
    rowIndex >= range.startRow && rowIndex <= range.endRow && colIndex >= range.startCol && colIndex <= range.endCol
  );
}

export function extractSelection(
  columns: readonly string[],
  rows: readonly GridCellValue[][],
  range: CellSelectionRange | null,
): SelectionData {
  if (!range) return { columns: [], rows: [] };

  const selectedColumns = columns.slice(range.startCol, range.endCol + 1);
  const selectedRows = rows
    .slice(range.startRow, range.endRow + 1)
    .map((row) => row.slice(range.startCol, range.endCol + 1));

  return { columns: selectedColumns, rows: selectedRows };
}

function displayValue(value: GridCellValue): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function csvValue(value: GridCellValue | string): string {
  const text = typeof value === "string" ? value : displayValue(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function sqlValue(value: GridCellValue): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function formatSelectionAsTsv(selection: SelectionData): string {
  const header = selection.columns.join("\t");
  const body = selection.rows.map((row) => row.map(displayValue).join("\t")).join("\n");
  return [header, body].filter(Boolean).join("\n");
}

export function formatSelectionAsCsv(selection: SelectionData): string {
  const header = selection.columns.map(csvValue).join(",");
  const body = selection.rows.map((row) => row.map(csvValue).join(",")).join("\n");
  return [header, body].filter(Boolean).join("\n");
}

export function formatSelectionAsJson(selection: SelectionData): string {
  const objects = selection.rows.map((row) => {
    const item: Record<string, GridCellValue> = {};
    selection.columns.forEach((column, index) => {
      item[column] = row[index] ?? null;
    });
    return item;
  });
  return JSON.stringify(objects, null, 2);
}

export function formatSelectionAsSqlInList(selection: SelectionData): string {
  const values = selection.rows.flat().map(sqlValue);
  return `(${values.join(", ")})`;
}
