import type { CellPosition } from "@/lib/dataGrid/gridSelection";

type CellValue = string | number | boolean | null;

export interface DataGridSelectionRow {
  id: number;
  sourceIndex?: number;
  isNew?: boolean;
  isDraft?: boolean;
}

interface RowIdentityToken {
  key: string;
  occurrence: number;
}

interface ColumnIdentityToken {
  resultName: string;
  sourceName?: string;
  occurrence: number;
}

type PersistedDataGridSelectionState =
  | { kind: "rows"; rows: RowIdentityToken[]; anchorRow?: RowIdentityToken }
  | { kind: "columns"; columns: ColumnIdentityToken[] }
  | { kind: "range"; anchor: { row: RowIdentityToken; column: ColumnIdentityToken }; focus: { row: RowIdentityToken; column: ColumnIdentityToken }; selectingAll: boolean }
  | { kind: "cells"; cells: Array<{ row: RowIdentityToken; column: ColumnIdentityToken }> };

export interface PersistedDataGridSelection {
  identity: { mode: "keys"; primaryKeys: readonly string[] } | { mode: "row"; columnSignature: string };
  state: PersistedDataGridSelectionState;
}

export interface CaptureDataGridSelectionOptions {
  columns: readonly string[];
  sourceColumns?: readonly (string | undefined)[];
  rows: readonly (readonly CellValue[])[];
  primaryKeys: readonly string[];
  visibleColumnIndexes: readonly number[];
  displayItems: readonly DataGridSelectionRow[];
  selectedRowIds: ReadonlySet<number>;
  selectedColumnIndexes: ReadonlySet<number>;
  selectedCellKeys: ReadonlySet<string>;
  selectionAnchor: CellPosition | null;
  selectionFocus: CellPosition | null;
  selectingAll: boolean;
  lastClickedRowIndex?: number | null;
}

export type RestoredDataGridSelection =
  | { kind: "rows"; rowIds: number[]; anchorRowIndex: number | null; scrollRowIndex: number }
  | { kind: "columns"; columnIndexes: number[] }
  | { kind: "range"; anchor: CellPosition; focus: CellPosition; selectingAll: boolean; scrollRowIndex: number }
  | { kind: "cells"; cellKeys: Set<string>; scrollRowIndex: number };

export interface RestoreDataGridSelectionOptions {
  snapshot: PersistedDataGridSelection;
  columns: readonly string[];
  sourceColumns?: readonly (string | undefined)[];
  rows: readonly (readonly CellValue[])[];
  visibleColumnIndexes: readonly number[];
  displayItems: readonly DataGridSelectionRow[];
}

function normalizeColumnName(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? "";
}

function columnSignature(columns: readonly string[], sourceColumns: readonly (string | undefined)[] | undefined): string {
  return columns.map((column, index) => `${normalizeColumnName(column)}\u0001${normalizeColumnName(sourceColumns?.[index])}`).join("\u0002");
}

function identityColumnIndexes(columns: readonly string[], sourceColumns: readonly (string | undefined)[] | undefined, primaryKeys: readonly string[]): number[] | null {
  if (primaryKeys.length === 0) return null;
  const indexes = primaryKeys.map((primaryKey) => {
    const target = normalizeColumnName(primaryKey);
    const sourceIndex = sourceColumns?.findIndex((column) => normalizeColumnName(column) === target) ?? -1;
    if (sourceIndex >= 0) return sourceIndex;
    return columns.findIndex((column, index) => !normalizeColumnName(sourceColumns?.[index]) && normalizeColumnName(column) === target);
  });
  return indexes.every((index) => index >= 0) ? indexes : null;
}

function serializeCellValue(value: CellValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${value.length}:${value}`;
  if (typeof value === "boolean") return value ? "boolean:1" : "boolean:0";
  if (Number.isNaN(value)) return "number:NaN";
  if (Object.is(value, -0)) return "number:-0";
  return `number:${String(value)}`;
}

function rowIdentityKey(row: readonly CellValue[], indexes: readonly number[]): string {
  return indexes.map((index) => serializeCellValue(row[index] ?? null)).join("\u0000");
}

function buildRowTokens(rows: readonly (readonly CellValue[])[], indexes: readonly number[]): RowIdentityToken[] {
  const occurrences = new Map<string, number>();
  return rows.map((row) => {
    const key = rowIdentityKey(row, indexes);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    return { key, occurrence };
  });
}

function rowTokenKey(token: RowIdentityToken): string {
  return `${token.key}\u0003${token.occurrence}`;
}

function buildColumnTokens(columns: readonly string[], sourceColumns: readonly (string | undefined)[] | undefined): ColumnIdentityToken[] {
  const occurrences = new Map<string, number>();
  return columns.map((resultName, index) => {
    const sourceName = sourceColumns?.[index];
    const key = `${normalizeColumnName(resultName)}\u0001${normalizeColumnName(sourceName)}`;
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    return { resultName, sourceName, occurrence };
  });
}

function columnTokenKey(token: ColumnIdentityToken): string {
  return `${normalizeColumnName(token.resultName)}\u0001${normalizeColumnName(token.sourceName)}\u0003${token.occurrence}`;
}

function parseCellKey(key: string): CellPosition | null {
  const [row, column] = key.split(":");
  const rowIndex = Number(row);
  const colIndex = Number(column);
  if (!Number.isInteger(rowIndex) || !Number.isInteger(colIndex) || rowIndex < 0 || colIndex < 0) return null;
  return { rowIndex, colIndex };
}

export function captureDataGridSelection(options: CaptureDataGridSelectionOptions): PersistedDataGridSelection | null {
  const hasSelection = options.selectedRowIds.size > 0 || options.selectedColumnIndexes.size > 0 || options.selectedCellKeys.size > 0 || (!!options.selectionAnchor && !!options.selectionFocus);
  if (!hasSelection) return null;

  const keyIndexes = identityColumnIndexes(options.columns, options.sourceColumns, options.primaryKeys);
  const identity = keyIndexes ? ({ mode: "keys", primaryKeys: [...options.primaryKeys] } as const) : ({ mode: "row", columnSignature: columnSignature(options.columns, options.sourceColumns) } as const);
  const columnTokens = buildColumnTokens(options.columns, options.sourceColumns);
  if (options.selectedColumnIndexes.size > 0) {
    const columns = [...options.selectedColumnIndexes]
      .map((visibleColumnIndex) => {
        const actualColumnIndex = options.visibleColumnIndexes[visibleColumnIndex];
        return actualColumnIndex === undefined ? undefined : columnTokens[actualColumnIndex];
      })
      .filter((token): token is ColumnIdentityToken => !!token);
    return columns.length > 0 ? { identity, state: { kind: "columns", columns } } : null;
  }

  const rowTokens = buildRowTokens(options.rows, keyIndexes ?? options.columns.map((_, index) => index));
  const displayRowToken = (displayRowIndex: number): RowIdentityToken | undefined => {
    const sourceIndex = options.displayItems[displayRowIndex]?.sourceIndex;
    return sourceIndex === undefined ? undefined : rowTokens[sourceIndex];
  };
  const visibleColumnToken = (visibleColumnIndex: number): ColumnIdentityToken | undefined => {
    const actualColumnIndex = options.visibleColumnIndexes[visibleColumnIndex];
    return actualColumnIndex === undefined ? undefined : columnTokens[actualColumnIndex];
  };

  if (options.selectedRowIds.size > 0) {
    const rows = options.displayItems
      .filter((item) => options.selectedRowIds.has(item.id) && item.sourceIndex !== undefined)
      .map((item) => rowTokens[item.sourceIndex!])
      .filter((token): token is RowIdentityToken => !!token);
    if (rows.length === 0) return null;
    const anchorSourceIndex = options.lastClickedRowIndex === null || options.lastClickedRowIndex === undefined ? undefined : options.displayItems[options.lastClickedRowIndex]?.sourceIndex;
    return { identity, state: { kind: "rows", rows, anchorRow: anchorSourceIndex === undefined ? undefined : rowTokens[anchorSourceIndex] } };
  }

  if (options.selectedCellKeys.size > 0) {
    const cells = [...options.selectedCellKeys]
      .map(parseCellKey)
      .filter((cell): cell is CellPosition => !!cell)
      .map((cell) => ({ row: displayRowToken(cell.rowIndex), column: visibleColumnToken(cell.colIndex) }))
      .filter((cell): cell is { row: RowIdentityToken; column: ColumnIdentityToken } => !!cell.row && !!cell.column);
    return cells.length > 0 ? { identity, state: { kind: "cells", cells } } : null;
  }

  if (options.selectionAnchor && options.selectionFocus) {
    const anchorRow = displayRowToken(options.selectionAnchor.rowIndex);
    const anchorColumn = visibleColumnToken(options.selectionAnchor.colIndex);
    const focusRow = displayRowToken(options.selectionFocus.rowIndex);
    const focusColumn = visibleColumnToken(options.selectionFocus.colIndex);
    if (!anchorRow || !anchorColumn || !focusRow || !focusColumn) return null;
    return {
      identity,
      state: {
        kind: "range",
        anchor: { row: anchorRow, column: anchorColumn },
        focus: { row: focusRow, column: focusColumn },
        selectingAll: options.selectingAll,
      },
    };
  }

  return null;
}

export function restoreDataGridSelection(options: RestoreDataGridSelectionOptions): RestoredDataGridSelection | null {
  const state = options.snapshot.state;
  const columnTokens = buildColumnTokens(options.columns, options.sourceColumns);
  const actualColumnIndexByToken = new Map(columnTokens.map((token, index) => [columnTokenKey(token), index]));
  const visibleColumnIndex = (token: ColumnIdentityToken): number | undefined => {
    const actualColumnIndex = actualColumnIndexByToken.get(columnTokenKey(token));
    if (actualColumnIndex === undefined) return undefined;
    const index = options.visibleColumnIndexes.indexOf(actualColumnIndex);
    return index >= 0 ? index : undefined;
  };

  if (state.kind === "columns") {
    const columnIndexes = state.columns.map(visibleColumnIndex).filter((index): index is number => index !== undefined);
    return columnIndexes.length > 0 ? { kind: "columns", columnIndexes } : null;
  }

  const identityIndexes =
    options.snapshot.identity.mode === "keys"
      ? identityColumnIndexes(options.columns, options.sourceColumns, options.snapshot.identity.primaryKeys)
      : options.snapshot.identity.columnSignature === columnSignature(options.columns, options.sourceColumns)
        ? options.columns.map((_, index) => index)
        : null;
  if (!identityIndexes) return null;

  const rowTokens = buildRowTokens(options.rows, identityIndexes);
  const sourceIndexByToken = new Map(rowTokens.map((token, sourceIndex) => [rowTokenKey(token), sourceIndex]));
  const displayRowIndexBySourceIndex = new Map<number, number>();
  options.displayItems.forEach((item, displayRowIndex) => {
    if (item.sourceIndex !== undefined) displayRowIndexBySourceIndex.set(item.sourceIndex, displayRowIndex);
  });
  const displayRowIndex = (token: RowIdentityToken): number | undefined => {
    const sourceIndex = sourceIndexByToken.get(rowTokenKey(token));
    return sourceIndex === undefined ? undefined : displayRowIndexBySourceIndex.get(sourceIndex);
  };

  if (state.kind === "rows") {
    const restoredRows = state.rows
      .map((token) => displayRowIndex(token))
      .filter((index): index is number => index !== undefined)
      .map((index) => ({ index, id: options.displayItems[index]!.id }));
    if (restoredRows.length === 0) return null;
    return {
      kind: "rows",
      rowIds: restoredRows.map((row) => row.id),
      anchorRowIndex: state.anchorRow ? (displayRowIndex(state.anchorRow) ?? restoredRows[0]!.index) : restoredRows[0]!.index,
      scrollRowIndex: restoredRows[0]!.index,
    };
  }

  if (state.kind === "range") {
    if (state.selectingAll && options.displayItems.length > 0 && options.visibleColumnIndexes.length > 0) {
      return {
        kind: "range",
        anchor: { rowIndex: 0, colIndex: 0 },
        focus: { rowIndex: options.displayItems.length - 1, colIndex: options.visibleColumnIndexes.length - 1 },
        selectingAll: true,
        scrollRowIndex: 0,
      };
    }
    const anchorRow = displayRowIndex(state.anchor.row);
    const anchorColumn = visibleColumnIndex(state.anchor.column);
    const focusRow = displayRowIndex(state.focus.row);
    const focusColumn = visibleColumnIndex(state.focus.column);
    if (anchorRow === undefined || anchorColumn === undefined || focusRow === undefined || focusColumn === undefined) return null;
    return {
      kind: "range",
      anchor: { rowIndex: anchorRow, colIndex: anchorColumn },
      focus: { rowIndex: focusRow, colIndex: focusColumn },
      selectingAll: state.selectingAll,
      scrollRowIndex: focusRow,
    };
  }

  const cellKeys = new Set<string>();
  let scrollRowIndex = -1;
  for (const cell of state.cells) {
    const rowIndex = displayRowIndex(cell.row);
    const colIndex = visibleColumnIndex(cell.column);
    if (rowIndex === undefined || colIndex === undefined) continue;
    cellKeys.add(`${rowIndex}:${colIndex}`);
    scrollRowIndex = rowIndex;
  }
  return cellKeys.size > 0 ? { kind: "cells", cellKeys, scrollRowIndex } : null;
}
