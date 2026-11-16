import { cellImagePreviewUrl } from "@/lib/dataGrid/cellImageUrl";
import { binaryCellClipboardText } from "@/lib/dataGrid/binaryCellDownload";
import { clipboardCellValue, displayCellValue, type CellValue } from "@/lib/dataGrid/cellValue";
import { formatJsonText, looksLikeJsonContainerText } from "@/lib/dataGrid/cellDetailPresentation";
import { isJsonTreeContainer } from "@/lib/common/jsonTree";
import { cqlLiteralToJsonText } from "@/lib/dataGrid/cqlLiteralJson";
import type { DatabaseType } from "@/types/database";

export const CELL_DETAIL_VALUE_PREVIEW_MAX_LENGTH = 12_000;

export interface DataGridCellDetail {
  rowNumber: number;
  rowId: number;
  colIndex: number;
  column: string;
  type: string;
  comment: string;
  value: CellValue;
  rawValue: string;
  rawValuePreview: string;
  displayValue: string;
  displayValuePreview: string;
  isValuePreviewTruncated: boolean;
  /** True only while the backend value is incomplete, not when the UI clips its preview. */
  isSourceTruncated?: boolean;
  imagePreviewUrl: string | null;
  length: number;
  isNull?: boolean;
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
  resultColumnTypes?: readonly string[];
  commentByColumn?: ReadonlyMap<string, string>;
  displayValue: (value: CellValue, columnIndex: number) => string;
  isEditable: boolean;
  rawValue?: (value: CellValue, columnIndex: number) => string;
  isNullValue?: (value: CellValue) => boolean;
  databaseType?: DatabaseType;
  includeBinaryImagePreview?: boolean;
  isValuePreviewTruncated?: boolean;
  /** Rendering only; never replaces the source value used by copy/export. */
  pendingDecodePlaceholder?: string;
}

export interface BuildDataGridRowDetailOptions {
  rowIndex: number;
  rowId: number;
  row: readonly CellValue[];
  columns: readonly string[];
  columnIndexes: readonly number[];
  typeByColumn?: ReadonlyMap<string, string>;
  resultColumnTypes?: readonly string[];
  commentByColumn?: ReadonlyMap<string, string>;
  displayValue: (value: CellValue, columnIndex: number) => string;
  rawValue?: (value: CellValue, columnIndex: number) => string;
  isNullValue?: (value: CellValue) => boolean;
  isEditableColumn?: (columnIndex: number) => boolean;
  isValuePreviewTruncated?: (columnIndex: number) => boolean;
  pendingDecodePlaceholder?: (columnIndex: number) => string | undefined;
}

export interface BuildDataGridColumnDetailRow {
  rowIndex: number;
  rowId: number;
  row: readonly CellValue[];
  isEditable?: boolean;
  isValuePreviewTruncated?: boolean;
  pendingDecodePlaceholder?: string;
}

export interface BuildDataGridColumnDetailOptions {
  rows: readonly BuildDataGridColumnDetailRow[];
  columns: readonly string[];
  columnIndex: number;
  typeByColumn?: ReadonlyMap<string, string>;
  resultColumnTypes?: readonly string[];
  commentByColumn?: ReadonlyMap<string, string>;
  /** Result-ordinal comment resolved by the grid; wins over the name map. */
  comment?: string;
  displayValue: (value: CellValue, columnIndex: number) => string;
  rawValue?: (value: CellValue, columnIndex: number) => string;
  isNullValue?: (value: CellValue) => boolean;
}

export function buildDataGridCellDetail(options: BuildDataGridCellDetailOptions): DataGridCellDetail | null {
  const column = options.columns[options.columnIndex];
  if (column === undefined) return null;

  const value = options.row[options.columnIndex] ?? null;
  const rawValue = options.rawValue?.(value, options.columnIndex) ?? displayCellValue(value);
  const isNull = options.isNullValue?.(value) ?? value === null;
  const displayValue = options.displayValue(value, options.columnIndex);
  const formattedJson = options.pendingDecodePlaceholder === undefined && typeof value === "string" ? detailFormattedJson(value, options.databaseType) : "";
  const rawValuePreview = options.pendingDecodePlaceholder ?? previewText(rawValue);
  const displayValuePreview = options.pendingDecodePlaceholder ?? previewText(displayValue);
  const type = detailColumnType(options.typeByColumn, options.resultColumnTypes, column, options.columnIndex);

  return {
    rowNumber: options.rowIndex + 1,
    rowId: options.rowId,
    colIndex: options.columnIndex,
    column,
    type,
    comment: options.commentByColumn?.get(column) ?? "",
    value,
    rawValue,
    rawValuePreview,
    displayValue,
    displayValuePreview,
    isSourceTruncated: options.isValuePreviewTruncated === true,
    isValuePreviewTruncated: options.isValuePreviewTruncated === true || rawValuePreview.length < rawValue.length || displayValuePreview.length < displayValue.length,
    imagePreviewUrl:
      options.pendingDecodePlaceholder === undefined
        ? cellImagePreviewUrl(value, type, {
            binary: options.includeBinaryImagePreview !== false,
            databaseType: options.databaseType,
          })
        : null,
    length: isNull ? 0 : rawValue.length,
    isNull,
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
        resultColumnTypes: options.resultColumnTypes,
        commentByColumn: options.commentByColumn,
        displayValue: options.displayValue,
        rawValue: options.rawValue,
        isNullValue: options.isNullValue,
        isEditable: row.isEditable ?? false,
        includeBinaryImagePreview: false,
        isValuePreviewTruncated: row.isValuePreviewTruncated,
        pendingDecodePlaceholder: row.pendingDecodePlaceholder,
      }),
    )
    .filter((field): field is DataGridCellDetail => field !== null);

  return {
    colIndex: options.columnIndex,
    column,
    type: detailColumnType(options.typeByColumn, options.resultColumnTypes, column, options.columnIndex),
    comment: options.comment?.trim() || options.commentByColumn?.get(column) || "",
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
        resultColumnTypes: options.resultColumnTypes,
        commentByColumn: options.commentByColumn,
        displayValue: options.displayValue,
        rawValue: options.rawValue,
        isNullValue: options.isNullValue,
        isEditable: options.isEditableColumn?.(columnIndex) ?? false,
        includeBinaryImagePreview: false,
        isValuePreviewTruncated: options.isValuePreviewTruncated?.(columnIndex),
        pendingDecodePlaceholder: options.pendingDecodePlaceholder?.(columnIndex),
      }),
    )
    .filter((field): field is DataGridCellDetail => field !== null);

  return {
    rowNumber: options.rowIndex + 1,
    rowId: options.rowId,
    fields,
  };
}

function detailColumnType(typeByColumn: ReadonlyMap<string, string> | undefined, resultColumnTypes: readonly string[] | undefined, column: string, columnIndex: number): string {
  const fromMeta = typeByColumn?.get(column)?.trim();
  if (fromMeta) return fromMeta;
  return resultColumnTypes?.[columnIndex]?.trim() ?? "";
}

/** Restores a grid-internal marker value (e.g. the Mongo BSON null sentinel) before it leaves the grid. */
export type DataGridDetailExternalValue = (value: CellValue) => CellValue;

function externalDetailFieldValue(value: CellValue, externalValue: DataGridDetailExternalValue | undefined): CellValue {
  const external = externalValue?.(value);
  return external === undefined ? value : external;
}

function dataGridRowFieldValue(field: DataGridCellDetail, databaseType?: DatabaseType, externalValue?: DataGridDetailExternalValue): CellValue {
  const value = externalDetailFieldValue(field.value, externalValue);
  return binaryCellClipboardText(value, field.type, databaseType) ?? value;
}

export function dataGridRowDetailJson(detail: DataGridRowDetail, originalDocument?: unknown, databaseType?: DatabaseType, externalValue?: DataGridDetailExternalValue): string {
  if (originalDocument !== undefined) return JSON.stringify(jsonDetailDisplayValue(originalDocument), null, 2);
  const row = Object.fromEntries(detail.fields.map((field) => [field.column, dataGridRowFieldValue(field, databaseType, externalValue)]));
  return JSON.stringify(jsonDetailDisplayValue(row), null, 2);
}

export const DATA_GRID_JSON_COMMENT_GAP = "    ";

export interface DataGridRowDetailPreviewField {
  columnIndex: number;
  column: string;
  value: unknown;
  text: string;
  comment: string;
  previewLength?: number;
  isTruncated: boolean;
}

export interface DataGridJsonPreviewLine {
  key: string;
  lineNumber: number;
  text: string;
  comment?: string;
  previewLength?: number;
  togglePath?: string;
  toggleLabel?: string;
  expanded?: boolean;
}

export function dataGridRowDetailPreviewFields(detail: DataGridRowDetail, databaseType?: DatabaseType): DataGridRowDetailPreviewField[] {
  return detail.fields.map((field, index) => {
    const sourceClipped = field.isSourceTruncated || field.rawValuePreview.length < field.rawValue.length;
    const value = sourceClipped ? field.rawValuePreview : jsonDetailDisplayValue(dataGridRowFieldValue(field, databaseType));
    const json = JSON.stringify(value, null, 2);
    const preview = json.slice(0, CELL_DETAIL_VALUE_PREVIEW_MAX_LENGTH);
    const isTruncated = sourceClipped || preview.length < json.length;
    const comma = index < detail.fields.length - 1 ? "," : "";
    return {
      columnIndex: field.colIndex,
      column: field.column,
      value,
      text: `  ${JSON.stringify(field.column)}: ${preview.replaceAll("\n", "\n  ")}${isTruncated ? "…" : ""}${comma}`,
      comment: field.comment,
      previewLength: sourceClipped ? field.rawValuePreview.length : isTruncated ? preview.length : undefined,
      isTruncated,
    };
  });
}

export function buildDataGridJsonPreviewLines(fields: readonly DataGridRowDetailPreviewField[], collapsedPaths: ReadonlySet<string> = new Set()): DataGridJsonPreviewLine[] {
  const lines: Omit<DataGridJsonPreviewLine, "lineNumber">[] = [{ key: "root-open", text: "{" }];

  fields.forEach((field, index) => {
    const path = `/${index}`;
    if (field.isTruncated) {
      appendRawPreviewField(lines, field, path);
      return;
    }

    appendJsonPreviewValue(lines, {
      value: field.value,
      depth: 1,
      path,
      label: field.column,
      comma: index < fields.length - 1 ? "," : "",
      comment: field.comment,
      previewLength: field.previewLength,
      collapsedPaths,
    });
  });

  lines.push({ key: "root-close", text: "}" });
  return lines.map((line, index) => ({ ...line, lineNumber: index + 1 }));
}

type JsonPreviewLine = Omit<DataGridJsonPreviewLine, "lineNumber">;

type AppendJsonPreviewValueOptions = {
  value: unknown;
  depth: number;
  path: string;
  label?: string;
  comma: string;
  comment?: string;
  previewLength?: number;
  collapsedPaths: ReadonlySet<string>;
};

function appendRawPreviewField(lines: JsonPreviewLine[], field: DataGridRowDetailPreviewField, path: string) {
  const textLines = field.text.split("\n");
  textLines.forEach((text, index) => {
    const lastLine = index === textLines.length - 1;
    lines.push({
      key: `${path}/raw/${index}`,
      text,
      comment: lastLine ? field.comment : undefined,
      previewLength: lastLine ? field.previewLength : undefined,
    });
  });
}

function appendJsonPreviewValue(lines: JsonPreviewLine[], options: AppendJsonPreviewValueOptions) {
  const { value, depth, path, label, comma, comment, previewLength, collapsedPaths } = options;
  const indent = "  ".repeat(depth);
  const labelText = label === undefined ? "" : `${JSON.stringify(label)}: `;

  if (!isJsonTreeContainer(value) || Object.keys(value).length === 0) {
    lines.push({
      key: `${path}/value`,
      text: `${indent}${labelText}${JSON.stringify(value)}${comma}`,
      comment,
      previewLength,
    });
    return;
  }

  const opening = Array.isArray(value) ? "[" : "{";
  const closing = Array.isArray(value) ? "]" : "}";
  const toggleLabel = label ?? (path || "$");
  if (collapsedPaths.has(path)) {
    lines.push({
      key: `${path}/collapsed`,
      text: `${indent}${labelText}${opening}…${closing}${comma}`,
      comment,
      previewLength,
      togglePath: path,
      toggleLabel,
      expanded: false,
    });
    return;
  }

  lines.push({
    key: `${path}/open`,
    text: `${indent}${labelText}${opening}`,
    comment,
    previewLength,
    togglePath: path,
    toggleLabel,
    expanded: true,
  });

  const children = Array.isArray(value) ? value.map((child, index) => [String(index), child] as const) : Object.entries(value);
  children.forEach(([key, child], index) => {
    appendJsonPreviewValue(lines, {
      value: child,
      depth: depth + 1,
      path: `${path}/${index}`,
      label: Array.isArray(value) ? undefined : key,
      comma: index < children.length - 1 ? "," : "",
      collapsedPaths,
    });
  });

  lines.push({ key: `${path}/close`, text: `${indent}${closing}${comma}` });
}

export function jsonDetailDisplayValue(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return jsonDetailDisplayValue(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(jsonDetailDisplayValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonDetailDisplayValue(item)]));
  }
  return value;
}

export function dataGridRowDetailTsv(detail: DataGridRowDetail, databaseType?: DatabaseType, externalValue?: DataGridDetailExternalValue): string {
  return detail.fields
    .map((field) => {
      const value = externalDetailFieldValue(field.value, externalValue);
      return clipboardCellValue(binaryCellClipboardText(value, field.type, databaseType) ?? value);
    })
    .join("\t");
}

export function dataGridColumnDetailJson(detail: DataGridColumnDetail, databaseType?: DatabaseType, externalValue?: DataGridDetailExternalValue): string {
  return JSON.stringify(
    detail.fields.map((field) => {
      const value = externalDetailFieldValue(field.value, externalValue);
      return {
        row: field.rowNumber,
        value: binaryCellClipboardText(value, field.type, databaseType) ?? value,
      };
    }),
    null,
    2,
  );
}

export function dataGridColumnDetailTsv(detail: DataGridColumnDetail, databaseType?: DatabaseType, externalValue?: DataGridDetailExternalValue): string {
  return detail.fields
    .map((field) => {
      const value = externalDetailFieldValue(field.value, externalValue);
      return clipboardCellValue(binaryCellClipboardText(value, field.type, databaseType) ?? value);
    })
    .join("\n");
}

export interface BuildDeleteRowConfirmDetailsOptions<TRow> {
  header: string;
  rowIds: readonly number[];
  columns: readonly string[];
  getRow: (rowId: number) => TRow | undefined;
  formatCell: (row: TRow, columnIndex: number) => string;
}

export function buildDeleteRowConfirmDetails<TRow>(options: BuildDeleteRowConfirmDetailsOptions<TRow>): string {
  const rowLines = options.rowIds
    .map((rowId) => options.getRow(rowId))
    .filter((row): row is TRow => row !== undefined)
    .map((row) => JSON.stringify(Object.fromEntries(options.columns.map((name, columnIndex) => [name, options.formatCell(row, columnIndex)]))));
  return rowLines.length > 0 ? [options.header, ...rowLines].join("\n") : options.header;
}

export function filterDataGridDetailFields<T extends DataGridCellDetail>(fields: readonly T[], keyword: string): T[] {
  if (keyword.trim() === "") return [...fields];
  const kw = keyword.trim().toLowerCase();
  return fields.filter((field) => field.column.toLowerCase().includes(kw) || field.rawValuePreview.toLowerCase().includes(kw) || field.displayValuePreview.toLowerCase().includes(kw) || String(field.rowNumber).includes(kw));
}

function detailFormattedJson(value: string, databaseType: DatabaseType | undefined): string {
  if (looksLikeJsonContainer(value)) {
    const formatted = formatJsonText(value);
    if (formatted !== undefined) return formatted;
  }
  if (databaseType !== "cassandra") return "";
  // The Cassandra agent renders collections as CQL literals, e.g. {'k': 'v'} or (1, 'a').
  const json = cqlLiteralToJsonText(value);
  return json === undefined ? "" : (formatJsonText(json) ?? "");
}

function looksLikeJsonContainer(text: string): boolean {
  return looksLikeJsonContainerText(text);
}

function previewText(text: string): string {
  if (text.length <= CELL_DETAIL_VALUE_PREVIEW_MAX_LENGTH) return text;
  return text.slice(0, CELL_DETAIL_VALUE_PREVIEW_MAX_LENGTH);
}
