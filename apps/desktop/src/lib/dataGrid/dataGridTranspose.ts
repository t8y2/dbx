import { COLUMN_WIDTH_DENSITY_PRESETS, percentileValue } from "@/lib/dataGrid/dataGridColumnWidth";
import { restoredDataGridScrollLeft } from "@/lib/dataGrid/dataGridInfiniteScroll";
import type { ColumnWidthDensity } from "@/stores/settingsStore";

export interface DataGridTransposeState {
  showTranspose: boolean;
  transposeRowIndex: number | null;
}

export interface BuildTransposeRowsOptions<T> {
  columns: string[];
  records: T[][];
  typeByColumn?: Map<string, string>;
  displayValue: (value: T, column: string, columnIndex: number, recordIndex: number) => string;
}

export interface DataGridTransposeCell<T> {
  value: T;
  display: string;
  isNull: boolean;
}

export interface DataGridVisibleTransposeCell<T> extends DataGridTransposeCell<T> {
  recordIndex: number;
  valueIndex: number;
}

export interface DataGridTransposeRow<T> {
  id: string;
  column: string;
  type: string;
  values: Array<DataGridTransposeCell<T>>;
}

export interface DataGridVisibleTransposeRow<T> {
  id: string;
  column: string;
  type: string;
  values: Array<DataGridVisibleTransposeCell<T>>;
}

export interface BuildVisibleTransposeRowsOptions<T> extends BuildTransposeRowsOptions<T> {
  recordIndexes: number[];
  valueIndexes?: number[];
}

export interface TransposeRecordWindowOptions {
  totalRecords: number;
  scrollLeft: number;
  viewportWidth: number;
  pinnedWidth: number;
  recordWidth: number;
  overscan?: number;
}

export interface TransposeRecordWindow {
  start: number;
  end: number;
  beforeWidth: number;
  afterWidth: number;
}

export interface TransposeSelectionRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export interface TransposeAnchorOptions {
  requestedRowIndex: number;
  rowIds: number[];
  selectedRowIds: Set<number>;
  selectedRange: TransposeSelectionRange | null;
}

export interface ContextTransposeStateOptions extends TransposeAnchorOptions {
  showTranspose: boolean;
  transposeRowIndex: number | null;
}

export type KeyboardTransposeStateOptions = ContextTransposeStateOptions;

export interface TransposeFieldWidthOptions {
  minWidth?: number;
  maxWidth?: number;
  charWidth?: number;
  padding?: number;
  density?: ColumnWidthDensity;
}

export interface TransposeRecordWidthsOptions {
  records: readonly (readonly unknown[])[];
  density: ColumnWidthDensity;
  previousWidths?: readonly number[];
  manualWidthIndexes?: ReadonlySet<number>;
}

const TRANSPOSE_RECORD_MIN_WIDTH = 96;
const TRANSPOSE_RECORD_DEFAULT_WIDTH = 168;
const TRANSPOSE_FIELD_MIN_WIDTH = 104;
const TRANSPOSE_FIELD_MAX_WIDTH = 220;

// 转置视图每种密度对应的缩放因子（不再依赖 charWidth）
const TRANSPOSE_DENSITY_SCALE: Record<ColumnWidthDensity, number> = {
  compact: 0.875,
  standard: 1,
  comfortable: 1.125,
};

function densityScaledWidth(width: number, density: ColumnWidthDensity): number {
  return Math.round(width * TRANSPOSE_DENSITY_SCALE[density]);
}

function transposeDisplayText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? (JSON.stringify(value) ?? String(value)) : String(value);
}

export function defaultTransposeRecordWidth(density: ColumnWidthDensity): number {
  return densityScaledWidth(TRANSPOSE_RECORD_DEFAULT_WIDTH, density);
}

export function minTransposeRecordWidth(density: ColumnWidthDensity): number {
  return densityScaledWidth(TRANSPOSE_RECORD_MIN_WIDTH, density);
}

export function minTransposeFieldWidth(density: ColumnWidthDensity): number {
  return densityScaledWidth(TRANSPOSE_FIELD_MIN_WIDTH, density);
}

export function calculateTransposeRecordWidth(values: readonly unknown[], density: ColumnWidthDensity): number {
  const preset = COLUMN_WIDTH_DENSITY_PRESETS[density];
  const minWidth = minTransposeRecordWidth(density);
  const scale = TRANSPOSE_DENSITY_SCALE[density];
  const valueWidths: number[] = [];
  for (const value of values) {
    const displayLen = Math.min(transposeDisplayText(value).length, preset.valueTextLimit);
    valueWidths.push(Math.round((displayLen * preset.charWidth + preset.cellPadding) * scale));
  }
  const maxWidth = Math.max(minWidth, percentileValue(valueWidths, preset.valueWidthPercentile));
  return Math.max(minWidth, Math.min(preset.maxWidth, Math.round(maxWidth)));
}

export function transposeRecordWidthsForDensity(options: TransposeRecordWidthsOptions): number[] {
  const previousWidths = options.previousWidths ?? [];
  const manualWidthIndexes = options.manualWidthIndexes ?? new Set<number>();
  return options.records.map((record, index) => (manualWidthIndexes.has(index) && previousWidths[index] !== undefined ? previousWidths[index] : calculateTransposeRecordWidth(record, options.density)));
}

export function averageTransposeRecordWidth(widths: readonly number[], density: ColumnWidthDensity): number {
  if (widths.length === 0) return defaultTransposeRecordWidth(density);
  return widths.reduce((sum, width) => sum + width, 0) / widths.length;
}

export interface TransposeScrollLeftOptions {
  recordIndex: number;
  totalRecords: number;
  viewportWidth: number;
  pinnedWidth: number;
  recordWidth: number;
}

export interface TransposeRecordIndexesForModeOptions {
  multiRow: boolean;
  activeRecordIndex: number | null;
  totalRecords: number;
  visibleRecordIndexes: number[];
}

export interface AutoTransposeSingleRowOptions {
  enabled: boolean;
  preserveTranspose: boolean;
  rowCount: number;
  columnCount: number;
}

export function nextTransposeState(showTranspose: boolean, transposeRowIndex: number | null, requestedRowIndex: number): DataGridTransposeState {
  if (showTranspose && transposeRowIndex === requestedRowIndex) {
    return { showTranspose: false, transposeRowIndex: null };
  }
  return { showTranspose: true, transposeRowIndex: requestedRowIndex };
}

export function restoreDataGridAfterTranspose(options: { scroller: Pick<HTMLElement, "scrollLeft" | "scrollWidth" | "clientWidth"> | null; scrollLeftBeforeTranspose: number; attachCanvasResizeObserver: () => void; refreshGridScrollerMetrics: () => void }) {
  if (!options.scroller) return;
  options.scroller.scrollLeft = restoredDataGridScrollLeft(options.scrollLeftBeforeTranspose, options.scroller.scrollWidth, options.scroller.clientWidth);
  options.attachCanvasResizeObserver();
  options.refreshGridScrollerMetrics();
}

export function nextContextTransposeState(options: ContextTransposeStateOptions): DataGridTransposeState {
  const anchorRowIndex = transposeAnchorRowIndex(options);
  return nextTransposeState(options.showTranspose, options.transposeRowIndex, anchorRowIndex);
}

export function nextKeyboardTransposeState(options: KeyboardTransposeStateOptions): DataGridTransposeState {
  if (options.showTranspose) return { showTranspose: false, transposeRowIndex: null };
  if (options.rowIds.length === 0) return { showTranspose: false, transposeRowIndex: null };
  const requestedRowIndex = Math.max(0, Math.min(options.rowIds.length - 1, options.requestedRowIndex));
  const anchorRowIndex = transposeAnchorRowIndex({ ...options, requestedRowIndex });
  return { showTranspose: true, transposeRowIndex: anchorRowIndex };
}

export function nextAppendedTransposeState(showTranspose: boolean, totalRecords: number): DataGridTransposeState {
  if (!showTranspose || totalRecords <= 0) return { showTranspose: false, transposeRowIndex: null };
  return { showTranspose: true, transposeRowIndex: totalRecords - 1 };
}

export function nextTransposeStateForRecordCount(showTranspose: boolean, transposeRowIndex: number | null, totalRecords: number): DataGridTransposeState {
  if (!showTranspose || totalRecords <= 0) return { showTranspose: false, transposeRowIndex: null };
  const requestedRowIndex = transposeRowIndex ?? 0;
  return {
    showTranspose: true,
    transposeRowIndex: Math.max(0, Math.min(totalRecords - 1, requestedRowIndex)),
  };
}

export function shouldAutoTransposeSingleRow(options: AutoTransposeSingleRowOptions): boolean {
  return options.enabled && !options.preserveTranspose && options.rowCount === 1 && options.columnCount > 1;
}

export function buildTransposeRows<T>(options: BuildTransposeRowsOptions<T>): Array<DataGridTransposeRow<T>> {
  return options.columns.map((column, columnIndex) => {
    return {
      id: `${columnIndex}:${column}`,
      column,
      type: options.typeByColumn?.get(column) || "",
      values: options.records.map((record, recordIndex) => {
        const value = record[columnIndex] as T;
        return {
          value,
          display: options.displayValue(value, column, columnIndex, recordIndex),
          isNull: value === null,
        };
      }),
    };
  });
}

export function buildVisibleTransposeRows<T>(options: BuildVisibleTransposeRowsOptions<T>): Array<DataGridVisibleTransposeRow<T>> {
  return options.columns.map((column, columnIndex) => {
    return {
      id: `${columnIndex}:${column}`,
      column,
      type: options.typeByColumn?.get(column) || "",
      values: options.recordIndexes.flatMap((recordIndex) => {
        const record = options.records[recordIndex];
        if (!record) return [];
        const valueIndex = options.valueIndexes?.[columnIndex] ?? columnIndex;
        const value = record[valueIndex] as T;
        return [
          {
            recordIndex,
            valueIndex,
            value,
            display: options.displayValue(value, column, columnIndex, recordIndex),
            isNull: value === null,
          },
        ];
      }),
    };
  });
}

export function visibleTransposeRecordWindow(options: TransposeRecordWindowOptions): TransposeRecordWindow {
  if (options.totalRecords <= 0 || options.recordWidth <= 0) {
    return { start: 0, end: 0, beforeWidth: 0, afterWidth: 0 };
  }

  const overscan = options.overscan ?? 2;
  const recordScrollLeft = Math.max(0, options.scrollLeft - options.pinnedWidth);
  const recordViewportWidth = Math.max(0, options.viewportWidth - options.pinnedWidth);
  const start = Math.max(0, Math.floor(recordScrollLeft / options.recordWidth) - overscan);
  const end = Math.min(options.totalRecords, Math.ceil((recordScrollLeft + recordViewportWidth) / options.recordWidth) + overscan + 1);

  return {
    start,
    end,
    beforeWidth: start * options.recordWidth,
    afterWidth: Math.max(0, (options.totalRecords - end) * options.recordWidth),
  };
}

export function transposeRecordIndexesForMode(options: TransposeRecordIndexesForModeOptions): number[] {
  if (options.totalRecords <= 0) return [];
  if (options.multiRow) return options.visibleRecordIndexes;
  const requested = options.activeRecordIndex ?? 0;
  return [Math.max(0, Math.min(options.totalRecords - 1, requested))];
}

export function transposeAnchorRowIndex(options: TransposeAnchorOptions): number {
  const requestedRowId = options.rowIds[options.requestedRowIndex];
  if (requestedRowId !== undefined && options.selectedRowIds.size > 1 && options.selectedRowIds.has(requestedRowId)) {
    const firstSelectedIndex = options.rowIds.findIndex((rowId) => options.selectedRowIds.has(rowId));
    if (firstSelectedIndex >= 0) return firstSelectedIndex;
  }

  const range = options.selectedRange;
  if (range && range.startRow !== range.endRow && options.requestedRowIndex >= range.startRow && options.requestedRowIndex <= range.endRow) {
    return range.startRow;
  }

  return options.requestedRowIndex;
}

export function transposeFieldWidth(columns: string[], options: TransposeFieldWidthOptions = {}): number {
  const density = options.density ?? "standard";
  const preset = COLUMN_WIDTH_DENSITY_PRESETS[density];
  const minWidth = options.minWidth ?? minTransposeFieldWidth(density);
  const maxWidth = options.maxWidth ?? densityScaledWidth(TRANSPOSE_FIELD_MAX_WIDTH, density);
  const charWidth = options.charWidth ?? preset.charWidth;
  const padding = options.padding ?? preset.cellPadding + 4;
  const longest = columns.reduce((max, column) => Math.max(max, column.length), 0);
  return Math.min(maxWidth, Math.max(minWidth, Math.ceil(longest * charWidth + padding)));
}

export function transposeScrollLeftForRecord(options: TransposeScrollLeftOptions): number {
  if (options.recordWidth <= 0 || options.totalRecords <= 0) return 0;
  const desired = Math.max(0, options.recordIndex) * options.recordWidth;
  const totalWidth = options.pinnedWidth + options.totalRecords * options.recordWidth;
  const maxScrollLeft = Math.max(0, totalWidth - options.viewportWidth);
  return Math.min(desired, maxScrollLeft);
}
