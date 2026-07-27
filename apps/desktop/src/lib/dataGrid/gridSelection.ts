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

export interface CellSelectionMatrix extends SelectionData {
  rowIndexes: number[];
  columnIndexes: number[];
}

export interface SelectionSummary {
  cellCount: number;
  rowCount: number;
  numericCount: number;
  sum: number;
}

export function parseClipboardTable(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");
  if (!normalized) return [[""]];
  return normalized.split("\n").map((row) => row.split("\t"));
}

export function normalizeSelectedColumnIndexes(columnIndexes: Iterable<number>): number[] {
  return [...new Set(columnIndexes)].filter((index) => index >= 0).sort((a, b) => a - b);
}

export function dedupeColumnIndexes(columnIndexes: Iterable<number>): number[] {
  // Deduplicate while preserving the first visible occurrence (insertion order)
  // instead of numeric order. Used by the copy/extractor path so drag-reordered
  // columns stay in the order the user sees them.
  return [...new Set(columnIndexes)].filter((index) => index >= 0);
}

export function normalizeSelectionRange(anchor: CellPosition, focus: CellPosition): CellSelectionRange {
  return {
    startRow: Math.min(anchor.rowIndex, focus.rowIndex),
    endRow: Math.max(anchor.rowIndex, focus.rowIndex),
    startCol: Math.min(anchor.colIndex, focus.colIndex),
    endCol: Math.max(anchor.colIndex, focus.colIndex),
  };
}

export function rowSelectionRange(rowIndex: number, columnCount: number, endRowIndex = rowIndex): CellSelectionRange | null {
  if (rowIndex < 0 || endRowIndex < 0 || columnCount <= 0) return null;
  return {
    startRow: Math.min(rowIndex, endRowIndex),
    endRow: Math.max(rowIndex, endRowIndex),
    startCol: 0,
    endCol: columnCount - 1,
  };
}

export function columnSelectionRange(rowCount: number, colIndex: number, endColIndex = colIndex): CellSelectionRange | null {
  if (rowCount <= 0 || colIndex < 0 || endColIndex < 0) return null;
  return {
    startRow: 0,
    endRow: rowCount - 1,
    startCol: Math.min(colIndex, endColIndex),
    endCol: Math.max(colIndex, endColIndex),
  };
}

export function allCellsSelectionRange(rowCount: number, columnCount: number): CellSelectionRange | null {
  if (rowCount <= 0 || columnCount <= 0) return null;
  return { startRow: 0, endRow: rowCount - 1, startCol: 0, endCol: columnCount - 1 };
}

export function isCellInSelection(rowIndex: number, colIndex: number, range: CellSelectionRange | null): boolean {
  if (!range) return false;
  return rowIndex >= range.startRow && rowIndex <= range.endRow && colIndex >= range.startCol && colIndex <= range.endCol;
}

export function extractSelection(columns: readonly string[], rows: readonly GridCellValue[][], range: CellSelectionRange | null): SelectionData {
  if (!range) return { columns: [], rows: [] };

  const selectedColumns = columns.slice(range.startCol, range.endCol + 1);
  const selectedRows = rows.slice(range.startRow, range.endRow + 1).map((row) => row.slice(range.startCol, range.endCol + 1));

  return { columns: selectedColumns, rows: selectedRows };
}

export function extractColumnsSelection(columns: readonly string[], rows: readonly GridCellValue[][], selectedColumnIndexes: Iterable<number>): SelectionData {
  const normalizedIndexes = normalizeSelectedColumnIndexes(selectedColumnIndexes).filter((index) => index < columns.length);
  if (normalizedIndexes.length === 0) return { columns: [], rows: [] };

  return {
    columns: normalizedIndexes.map((index) => columns[index]),
    rows: rows.map((row) => normalizedIndexes.map((index) => row[index] ?? null)),
  };
}

export function summarizeSelection(selection: SelectionData): SelectionSummary {
  let numericCount = 0;
  let sum = 0;

  for (const row of selection.rows) {
    for (const value of row) {
      const numericValue = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
      if (Number.isFinite(numericValue)) {
        numericCount += 1;
        sum += numericValue;
      }
    }
  }

  return {
    cellCount: selection.rows.reduce((count, row) => count + row.length, 0),
    rowCount: selection.rows.length,
    numericCount,
    sum,
  };
}
