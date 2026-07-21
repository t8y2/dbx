import { eventTargetUsesNativeClipboard, getClipboardWriteRevision } from "@/lib/common/clipboard";
import { displayCellValue, type CellValue } from "@/lib/dataGrid/cellValue";
import { parseClipboardTable } from "@/lib/dataGrid/gridSelection";

export type DataGridPasteIntent = "native" | "block" | "paste";

export interface DataGridPasteCell {
  rowOffset: number;
  columnOffset: number;
  value: string | null;
}

interface InternalDataGridClipboardCopy {
  text: string;
  rows: Array<Array<string | null>>;
  writeRevision: number;
}

let internalClipboardCopy: InternalDataGridClipboardCopy | null = null;

interface DataGridPasteEvent {
  target?: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

export function claimDataGridPaste(event: DataGridPasteEvent, editable: boolean, hasSelection: boolean): DataGridPasteIntent {
  if (eventTargetUsesNativeClipboard(event)) return "native";
  event.preventDefault();
  event.stopPropagation();
  return editable && hasSelection ? "paste" : "block";
}

export function clearDataGridClipboardCopy(): void {
  internalClipboardCopy = null;
}

export function rememberDataGridClipboardCopy(text: string, rows: readonly (readonly unknown[])[], includeHeader = false): void {
  if (!rows.some((row) => row.some((value) => value === null))) {
    internalClipboardCopy = null;
    return;
  }

  // Preserve the logical grid matrix because plain TSV cannot escape embedded tabs or newlines.
  const headerRows = includeHeader ? parseClipboardTable(text).slice(0, 1) : [];
  const copiedRows = rows.map((row) => row.map((value) => (value === null ? null : displayCellValue(value as CellValue))));
  internalClipboardCopy = { text, rows: [...headerRows, ...copiedRows], writeRevision: getClipboardWriteRevision() };
}

export function parseDataGridClipboard(text: string): Array<Array<string | null>> {
  if (internalClipboardCopy?.text === text && internalClipboardCopy.writeRevision === getClipboardWriteRevision()) {
    return internalClipboardCopy.rows.map((row) => [...row]);
  }
  return parseClipboardTable(text);
}

export function planDataGridPaste(rows: readonly (readonly (string | null)[])[], maxRows: number, maxColumns: number): DataGridPasteCell[] {
  if (maxRows <= 0 || maxColumns <= 0) return [];
  const cells: DataGridPasteCell[] = [];
  rows.slice(0, maxRows).forEach((row, rowOffset) => {
    row.slice(0, maxColumns).forEach((value, columnOffset) => {
      cells.push({ rowOffset, columnOffset, value });
    });
  });
  return cells;
}
