import { eventTargetUsesNativeClipboard } from "@/lib/common/clipboard";

export type DataGridPasteIntent = "native" | "block" | "paste";

export interface DataGridPasteCell {
  rowOffset: number;
  columnOffset: number;
  value: string;
}

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

export function planDataGridPaste(rows: readonly (readonly string[])[], maxRows: number, maxColumns: number): DataGridPasteCell[] {
  if (maxRows <= 0 || maxColumns <= 0) return [];
  const cells: DataGridPasteCell[] = [];
  rows.slice(0, maxRows).forEach((row, rowOffset) => {
    row.slice(0, maxColumns).forEach((value, columnOffset) => {
      cells.push({ rowOffset, columnOffset, value });
    });
  });
  return cells;
}
