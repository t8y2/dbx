import { cellImagePreviewUrl } from "@/lib/cellImageUrl";
import { displayCellValue, type CellValue } from "@/lib/cellValue";
import { formatJsonText } from "@/lib/cellDetailPresentation";

export interface DataGridCellDetail {
  rowNumber: number;
  rowId: number;
  colIndex: number;
  column: string;
  type: string;
  comment: string;
  value: CellValue;
  rawValue: string;
  displayValue: string;
  imagePreviewUrl: string | null;
  length: number;
  formattedJson: string;
  isEditable: boolean;
}

export interface DataGridRowDetail {
  rowNumber: number;
  rowId: number;
  fields: DataGridCellDetail[];
}

export interface DataGridColumnDetail {
  colIndex: number;
  column: string;
  type: string;
  comment: string;
  fields: DataGridCellDetail[];
}

export interface BuildDataGridCellDetailOptions {
  rowIndex: number;
  rowId: number;
  row: readonly CellValue[];
  columns: readonly string[];
  columnIndex: number;
  typeByColumn?: ReadonlyMap<string, string>;
  commentByColumn?: ReadonlyMap<string, string>;
  displayValue: (value: CellValue, columnIndex: number) => string;
  isEditable: boolean;
}

export interface BuildDataGridRowDetailOptions {
  rowIndex: number;
  rowId: number;
  row: readonly CellValue[];
  columns: readonly string[];
  columnIndexes: readonly number[];
  typeByColumn?: ReadonlyMap<string, string>;
  commentByColumn?: ReadonlyMap<string, string>;
  displayValue: (value: CellValue, columnIndex: number) => string;
  isEditableColumn?: (columnIndex: number) => boolean;
}

export interface BuildDataGridColumnDetailRow {
  rowIndex: number;
  rowId: number;
  row: readonly CellValue[];
  isEditable?: boolean;
}

export interface BuildDataGridColumnDetailOptions {
  rows: readonly BuildDataGridColumnDetailRow[];
  columns: readonly string[];
  columnIndex: number;
  typeByColumn?: ReadonlyMap<string, string>;
  commentByColumn?: ReadonlyMap<string, string>;
  displayValue: (value: CellValue, columnIndex: number) => string;
}

export function buildDataGridCellDetail(options: BuildDataGridCellDetailOptions): DataGridCellDetail | null {
  const column = options.columns[options.columnIndex];
  if (column === undefined) return null;

  const value = options.row[options.columnIndex] ?? null;
  const rawValue = displayCellValue(value);
  const formattedJson = typeof value === "string" && looksLikeJsonContainer(value) ? (formatJsonText(value) ?? "") : "";

  return {
    rowNumber: options.rowIndex + 1,
    rowId: options.rowId,
    colIndex: options.columnIndex,
    column,
    type: options.typeByColumn?.get(column) ?? "",
    comment: options.commentByColumn?.get(column) ?? "",
    value,
    rawValue,
    displayValue: options.displayValue(value, options.columnIndex),
    imagePreviewUrl: cellImagePreviewUrl(value),
    length: value === null ? 0 : String(value).length,
    formattedJson,
    isEditable: options.isEditable,
  };
}

export function buildDataGridColumnDetail(options: BuildDataGridColumnDetailOptions): DataGridColumnDetail | null {
  const column = options.columns[options.columnIndex];
  if (column === undefined) return null;

  const fields = options.rows
    .map((row) =>
      buildDataGridCellDetail({
        rowIndex: row.rowIndex,
        rowId: row.rowId,
        row: row.row,
        columns: options.columns,
        columnIndex: options.columnIndex,
        typeByColumn: options.typeByColumn,
        commentByColumn: options.commentByColumn,
        displayValue: options.displayValue,
        isEditable: row.isEditable ?? false,
      }),
    )
    .filter((field): field is DataGridCellDetail => field !== null);

  return {
    colIndex: options.columnIndex,
    column,
    type: options.typeByColumn?.get(column) ?? "",
    comment: options.commentByColumn?.get(column) ?? "",
    fields,
  };
}

export function buildDataGridRowDetail(options: BuildDataGridRowDetailOptions): DataGridRowDetail {
  const fields = options.columnIndexes
    .map((columnIndex) =>
      buildDataGridCellDetail({
        rowIndex: options.rowIndex,
        rowId: options.rowId,
        row: options.row,
        columns: options.columns,
        columnIndex,
        typeByColumn: options.typeByColumn,
        commentByColumn: options.commentByColumn,
        displayValue: options.displayValue,
        isEditable: options.isEditableColumn?.(columnIndex) ?? false,
      }),
    )
    .filter((field): field is DataGridCellDetail => field !== null);

  return {
    rowNumber: options.rowIndex + 1,
    rowId: options.rowId,
    fields,
  };
}

export function dataGridRowDetailJson(detail: DataGridRowDetail): string {
  const row: Record<string, CellValue> = {};
  detail.fields.forEach((field) => {
    row[field.column] = field.value;
  });
  return JSON.stringify(row, null, 2);
}

export function dataGridRowDetailTsv(detail: DataGridRowDetail): string {
  return detail.fields.map((field) => displayCellValue(field.value)).join("\t");
}

export function dataGridColumnDetailJson(detail: DataGridColumnDetail): string {
  return JSON.stringify(
    detail.fields.map((field) => ({
      row: field.rowNumber,
      value: field.value,
    })),
    null,
    2,
  );
}

export function dataGridColumnDetailTsv(detail: DataGridColumnDetail): string {
  return detail.fields.map((field) => displayCellValue(field.value)).join("\n");
}

function looksLikeJsonContainer(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}
