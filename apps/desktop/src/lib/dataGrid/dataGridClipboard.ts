import { eventTargetUsesNativeClipboard } from "@/lib/common/clipboard";
import { parseClipboardTable } from "@/lib/dataGrid/gridSelection";

export type DataGridPasteIntent = "native" | "block" | "paste";

export interface DataGridPasteCell {
  rowOffset: number;
  columnOffset: number;
  value: string | null;
}

interface InternalDataGridClipboardCopy {
  text: string;
  nullCells: Set<string>;
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
  const rowOffset = includeHeader ? 1 : 0;
  const nullCells = new Set<string>();
  rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      if (value === null) nullCells.add(`${rowIndex + rowOffset}:${columnIndex}`);
    });
  });
  internalClipboardCopy = nullCells.size > 0 ? { text, nullCells } : null;
}

export function parseDataGridClipboard(text: string): Array<Array<string | null>> {
  const rows = parseClipboardTable(text);
  if (internalClipboardCopy?.text !== text) return rows;
  return rows.map((row, rowIndex) => row.map((value, columnIndex) => (internalClipboardCopy?.nullCells.has(`${rowIndex}:${columnIndex}`) ? null : value)));
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
