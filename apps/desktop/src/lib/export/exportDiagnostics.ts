import type { CellValue } from "@/lib/dataGrid/cellValue";

export interface ExportRowsDiagnostics {
  rowCount: number;
  cellCount: number;
  nullCellCount: number;
  stringCellCount: number;
  numberCellCount: number;
  booleanCellCount: number;
  totalValueChars: number;
  totalValueUtf8Bytes: number;
  maxValueChars: number;
  maxValueUtf8Bytes: number;
  cellsAtLeast1MiB: number;
  cellsAtLeast10MiB: number;
  rowsAtLeast1MiB: number;
  minCellsPerRow: number;
  maxCellsPerRow: number;
}

const MEBIBYTE = 1024 * 1024;

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export function summarizeExportRows(rows: readonly (readonly CellValue[])[]): ExportRowsDiagnostics {
  let cellCount = 0;
  let nullCellCount = 0;
  let stringCellCount = 0;
  let numberCellCount = 0;
  let booleanCellCount = 0;
  let totalValueChars = 0;
  let totalValueUtf8Bytes = 0;
  let maxValueChars = 0;
  let maxValueUtf8Bytes = 0;
  let cellsAtLeast1MiB = 0;
  let cellsAtLeast10MiB = 0;
  let rowsAtLeast1MiB = 0;
  let minCellsPerRow = rows.length === 0 ? 0 : Number.POSITIVE_INFINITY;
  let maxCellsPerRow = 0;

  for (const row of rows) {
    minCellsPerRow = Math.min(minCellsPerRow, row.length);
    maxCellsPerRow = Math.max(maxCellsPerRow, row.length);
    let rowHasLargeCell = false;
    for (const value of row) {
      cellCount += 1;
      if (value === null) {
        nullCellCount += 1;
        continue;
      }
      if (typeof value === "string") stringCellCount += 1;
      else if (typeof value === "number") numberCellCount += 1;
      else booleanCellCount += 1;

      const text = String(value);
      const utf8Bytes = utf8ByteLength(text);
      totalValueChars += text.length;
      totalValueUtf8Bytes += utf8Bytes;
      maxValueChars = Math.max(maxValueChars, text.length);
      maxValueUtf8Bytes = Math.max(maxValueUtf8Bytes, utf8Bytes);
      if (utf8Bytes >= MEBIBYTE) {
        cellsAtLeast1MiB += 1;
        rowHasLargeCell = true;
      }
      if (utf8Bytes >= 10 * MEBIBYTE) cellsAtLeast10MiB += 1;
    }
    if (rowHasLargeCell) rowsAtLeast1MiB += 1;
  }

  return {
    rowCount: rows.length,
    cellCount,
    nullCellCount,
    stringCellCount,
    numberCellCount,
    booleanCellCount,
    totalValueChars,
    totalValueUtf8Bytes,
    maxValueChars,
    maxValueUtf8Bytes,
    cellsAtLeast1MiB,
    cellsAtLeast10MiB,
    rowsAtLeast1MiB,
    minCellsPerRow: Number.isFinite(minCellsPerRow) ? minCellsPerRow : 0,
    maxCellsPerRow,
  };
}
