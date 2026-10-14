import { eventTargetUsesNativeClipboard, getClipboardWriteRevision } from "@/lib/common/clipboard";
import { displayCellValue, type CellValue } from "@/lib/dataGrid/cellValue";
import { DATA_GRID_CLIPBOARD_BATCH_CHARS, DataGridClipboardCapacityError, finishDataGridRowPreparation, runDataGridRowPreparation, type DataGridClipboardLimits, type DataGridRowPreparationOptions, type DataGridRowPreparationProgress } from "@/lib/dataGrid/dataGridRowPreparation";

export type DataGridPasteIntent = "native" | "block" | "paste";
export type DataGridSelectAllIntent = "native" | "block" | "select";

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

interface DataGridSelectAllEvent {
  target?: EventTarget | null;
  preventDefault(): void;
}

export function claimDataGridSelectAll(event: DataGridSelectAllEvent, loading: boolean, hasData: boolean): DataGridSelectAllIntent {
  if (eventTargetUsesNativeClipboard(event) || (!loading && !hasData)) return "native";
  event.preventDefault();
  return loading ? "block" : "select";
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

export function rememberDataGridClipboardCopy(text: string, rows: readonly (readonly unknown[])[], header?: readonly unknown[]): void {
  // Preserve the logical grid matrix because plain TSV cannot escape embedded tabs or newlines.
  const headerRows = header ? [header.map((value) => displayCellValue(value as CellValue))] : [];
  const copiedRows = rows.map((row) => row.map((value) => (value === null ? null : displayCellValue(value as CellValue))));
  internalClipboardCopy = { text, rows: [...headerRows, ...copiedRows], writeRevision: getClipboardWriteRevision() };
}

export function parseDataGridClipboard(text: string, limits: DataGridClipboardLimits = {}): Array<Array<string | null>> {
  return finishDataGridRowPreparation(prepareDataGridClipboard(text, limits));
}

export function parseDataGridClipboardInBatches(text: string, options: DataGridRowPreparationOptions = {}, limits: DataGridClipboardLimits = {}): Promise<Array<Array<string | null>> | null> {
  return runDataGridRowPreparation(prepareDataGridClipboard(text, limits), options, null);
}

function* prepareDataGridClipboard(text: string, limits: DataGridClipboardLimits): Generator<DataGridRowPreparationProgress, Array<Array<string | null>>> {
  const maxRows = limits.maxRows ?? 100_000;
  const maxCells = limits.maxCells ?? 1_000_000;
  let cells = 0;
  const rows: Array<Array<string | null>> = [];
  if (internalClipboardCopy?.text === text && internalClipboardCopy.writeRevision === getClipboardWriteRevision()) {
    const source = internalClipboardCopy.rows;
    if (source.length > maxRows) throw new DataGridClipboardCapacityError();
    if (source.length > 1000) yield { completed: 0, total: source.length, phase: "parsing" };
    for (const row of source) {
      cells += row.length;
      if (cells > maxCells) throw new DataGridClipboardCapacityError();
      rows.push([...row]);
      if (rows.length % 1000 === 0) yield { completed: rows.length, total: source.length, phase: "parsing" };
    }
    return rows;
  }
  let row: Array<string | null> = [];
  let start = 0;
  let nextYield = DATA_GRID_CLIPBOARD_BATCH_CHARS;
  if (text.length > DATA_GRID_CLIPBOARD_BATCH_CHARS) yield { completed: 0, total: text.length, phase: "parsing" };
  const appendCell = (end: number) => {
    if (rows.length >= maxRows || ++cells > maxCells) throw new DataGridClipboardCapacityError();
    row.push(text.slice(start, end));
  };
  for (let index = 0; index < text.length; index++) {
    if (index >= nextYield) {
      yield { completed: index, total: text.length, phase: "parsing" };
      nextYield = index + DATA_GRID_CLIPBOARD_BATCH_CHARS;
    }
    const char = text[index];
    if (char !== "\t" && char !== "\r" && char !== "\n") continue;
    appendCell(index);
    if (char !== "\t") {
      rows.push(row);
      row = [];
      if (char === "\r" && text[index + 1] === "\n") index++;
      if (rows.length % 1000 === 0) yield { completed: index + 1, total: text.length, phase: "parsing" };
    }
    start = index + 1;
  }
  if (start < text.length || row.length || !rows.length) {
    appendCell(text.length);
    rows.push(row);
  }
  return rows;
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
