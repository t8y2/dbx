import { ref, computed, watch, type ComputedRef, type Ref } from "vue";
import { calculateDataGridColumnWidth, DATA_GRID_AUTO_FIT_VALUE_TEXT_LIMIT, DATA_GRID_COL_AUTO_FIT_MAX_WIDTH, DATA_GRID_COL_MIN_WIDTH, COLUMN_WIDTH_DENSITY_PRESETS, sampleDataGridColumnValues } from "@/lib/dataGrid/dataGridColumnWidth";
import { createDataGridColumnMeasurementSignature, loadDataGridColumnWidthState, removeDataGridColumnWidthState, saveDataGridColumnWidthState } from "@/lib/dataGrid/dataGridColumnWidthState";
import type { ColumnWidthDensity } from "@/stores/settingsStore";

type CellValue = string | number | boolean | null;

/** Minimum row-number gutter; fits ~4 digits with px-2 padding. */
export const DATA_GRID_ROW_NUM_WIDTH = 48;

/** Largest absolute row number that may appear in the gutter for the current page/window. */
export function resolveDataGridMaxRowNumber(options: { infiniteScroll: boolean; allRowsLoaded: boolean; currentPage: number; pageSize: number; rowCount: number }): number {
  if (options.infiniteScroll || options.allRowsLoaded) {
    return Math.max(1, options.rowCount);
  }
  const pageSize = Math.max(1, options.pageSize);
  return Math.max(1, Math.max(0, options.currentPage - 1) * pageSize + Math.max(options.rowCount, 1));
}

/** Grow the sticky # column so multi-million row indexes are not clipped or spilled into data cells. */
export function dataGridRowNumberColumnWidth(maxRowNumber: number, fontSize = 12, measureTextWidth?: (text: string) => number | undefined): number {
  const text = String(Math.max(1, Math.floor(Math.max(0, maxRowNumber))));
  const measured = measureTextWidth?.(text);
  const contentWidth = typeof measured === "number" && Number.isFinite(measured) && measured > 0 ? measured : text.length * Math.max(8, Math.ceil(fontSize * 0.65));
  // Keep ~4 digits in the default 48px gutter; measured text gets the same 16px padding as px-2.
  return Math.max(DATA_GRID_ROW_NUM_WIDTH, Math.ceil(contentWidth) + 16);
}

export function resizeDataGridColumnWidth(startWidth: number, deltaX: number): number {
  return Math.max(DATA_GRID_COL_MIN_WIDTH, startWidth + deltaX);
}

export interface UseDataGridColumnResizeOptions {
  columns: ComputedRef<string[]>;
  sourceRows: ComputedRef<CellValue[][]>;
  columnIndexes: ComputedRef<number[]>;
  density: Ref<ColumnWidthDensity>;
  compactColumnHeaderActions: ComputedRef<boolean>;
  cacheKey?: ComputedRef<string | undefined>;
  columnStructureSignature: ComputedRef<string>;
  measureHeaderText?: (text: string) => number | undefined;
  headerMeasurementKey?: Ref<unknown>;
  rowNumberWidth?: Ref<number> | ComputedRef<number>;
}

export function useDataGridColumnResize(options: UseDataGridColumnResizeOptions) {
  const { columns, sourceRows, columnIndexes, density, compactColumnHeaderActions, measureHeaderText } = options;

  const columnWidths = ref<number[]>([]);
  let isResizing = false;
  let previousColumnIndexes: number[] = [];
  let userSizedColumnIndexes = new Set<number>();

  function columnWidthStateIdentity() {
    return {
      cacheKey: options.cacheKey?.value,
      structureSignature: options.columnStructureSignature.value,
      measurementSignature: createDataGridColumnMeasurementSignature(density.value, compactColumnHeaderActions.value, options.headerMeasurementKey?.value),
    };
  }

  function persistColumnWidths() {
    saveDataGridColumnWidthState(columnWidthStateIdentity(), previousColumnIndexes, columnWidths.value, userSizedColumnIndexes);
  }

  function sampleColumnValues(visibleColIdx: number): CellValue[] {
    const actualColIdx = columnIndexes.value[visibleColIdx];
    if (actualColIdx === undefined) return [];
    const preset = COLUMN_WIDTH_DENSITY_PRESETS[density.value];
    return sampleDataGridColumnValues(sourceRows.value, actualColIdx, preset.sampleRows);
  }

  function neededColumnWidth(colIdx: number): number {
    const colName = columns.value[colIdx];
    if (!colName) return DATA_GRID_COL_MIN_WIDTH;
    return calculateDataGridColumnWidth({
      columnName: colName,
      sampleValues: sampleColumnValues(colIdx),
      density: density.value,
      compactColumnHeaderActions: compactColumnHeaderActions.value,
      headerTextWidth: measureHeaderText?.(colName),
    });
  }

  const neededColumnWidths = computed(() => columns.value.map((_, colIdx) => neededColumnWidth(colIdx)));
  const neededColumnWidthSignature = computed(() => neededColumnWidths.value.join("|"));

  /** Grow-only: late pages with larger keys must not stay stuck at a short-header / early-page width. */
  function growColumnWidthsToFitSamples(neededWidths = neededColumnWidths.value) {
    if (columnWidths.value.length !== columns.value.length || columns.value.length === 0) return;
    let grew = false;
    const next = columnWidths.value.slice();
    for (let colIdx = 0; colIdx < columns.value.length; colIdx++) {
      const actualColIdx = columnIndexes.value[colIdx];
      if (actualColIdx === undefined || userSizedColumnIndexes.has(actualColIdx)) continue;
      const needed = neededWidths[colIdx] ?? DATA_GRID_COL_MIN_WIDTH;
      if (needed > (next[colIdx] ?? 0)) {
        next[colIdx] = needed;
        grew = true;
      }
    }
    if (!grew) return;
    columnWidths.value = next;
    persistColumnWidths();
  }

  function markColumnUserSized(visibleColIdx: number) {
    const actualColIdx = columnIndexes.value[visibleColIdx];
    if (actualColIdx !== undefined) userSizedColumnIndexes.add(actualColIdx);
  }

  function initColumnWidths(force = false) {
    if (force) userSizedColumnIndexes.clear();
    const previousWidthsByColumnIndex = new Map<number, number>();
    previousColumnIndexes.forEach((columnIndex, visibleIndex) => {
      const width = columnWidths.value[visibleIndex];
      if (width !== undefined) previousWidthsByColumnIndex.set(columnIndex, width);
    });
    const nextColumnIndexes = [...columnIndexes.value];
    const cachedState = !force && previousColumnIndexes.length === 0 ? loadDataGridColumnWidthState(columnWidthStateIdentity(), nextColumnIndexes) : undefined;
    if (cachedState) userSizedColumnIndexes = new Set(cachedState.userSizedColumnIndexes);
    const currentNeededWidths = neededColumnWidths.value;
    if (force || columnWidths.value.length !== columns.value.length || previousColumnIndexes.join("\0") !== nextColumnIndexes.join("\0")) {
      columnWidths.value = columns.value.map((_, colIdx) => {
        if (!force) {
          const existingWidth = previousWidthsByColumnIndex.get(nextColumnIndexes[colIdx]);
          if (existingWidth !== undefined) return existingWidth;
          const cachedWidth = cachedState?.widths[colIdx];
          if (cachedWidth !== undefined) return cachedWidth;
        }
        return currentNeededWidths[colIdx] ?? DATA_GRID_COL_MIN_WIDTH;
      });
    }
    previousColumnIndexes = nextColumnIndexes;
    growColumnWidthsToFitSamples(currentNeededWidths);
  }

  function onResizeStart(colIdx: number, event: MouseEvent) {
    event.preventDefault();
    isResizing = true;
    const startX = event.clientX;
    const startWidth = columnWidths.value[colIdx] ?? DATA_GRID_COL_MIN_WIDTH;
    let pendingClientX = startX;
    let resizeFrame = 0;

    const applyPendingWidth = () => {
      resizeFrame = 0;
      columnWidths.value[colIdx] = resizeDataGridColumnWidth(startWidth, pendingClientX - startX);
    };

    const scheduleWidthUpdate = (clientX: number) => {
      pendingClientX = clientX;
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(applyPendingWidth);
    };

    const cancelPendingFrame = () => {
      if (!resizeFrame) return;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = 0;
    };

    const onMove = (e: MouseEvent) => {
      scheduleWidthUpdate(e.clientX);
    };
    const onUp = (e: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      cancelPendingFrame();
      pendingClientX = e.clientX;
      applyPendingWidth();
      markColumnUserSized(colIdx);
      persistColumnWidths();
      requestAnimationFrame(() => {
        isResizing = false;
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function autoFitColumn(colIdx: number) {
    const colName = columns.value[colIdx];
    if (!colName) return;
    columnWidths.value[colIdx] = calculateDataGridColumnWidth({
      columnName: colName,
      sampleValues: sampleColumnValues(colIdx),
      maxWidth: DATA_GRID_COL_AUTO_FIT_MAX_WIDTH,
      valueTextLimit: DATA_GRID_AUTO_FIT_VALUE_TEXT_LIMIT,
      density: density.value,
      compactColumnHeaderActions: compactColumnHeaderActions.value,
      includeValues: true,
      headerTextWidth: measureHeaderText?.(colName),
    });
    markColumnUserSized(colIdx);
    persistColumnWidths();
  }

  const renderedColumnWidths = computed(() => columnWidths.value.slice());

  const resolvedRowNumberWidth = computed(() => options.rowNumberWidth?.value ?? DATA_GRID_ROW_NUM_WIDTH);

  const totalWidth = computed(() => renderedColumnWidths.value.reduce((a, b) => a + b, 0) + resolvedRowNumberWidth.value);

  const columnVars = computed(() => {
    const vars: Record<string, string> = {};
    renderedColumnWidths.value.forEach((w, i) => {
      vars[`--col-w-${i}`] = `${w}px`;
    });
    vars["--row-num-w"] = `${resolvedRowNumberWidth.value}px`;
    vars["--total-w"] = `${totalWidth.value}px`;
    return vars;
  });

  function getIsResizing() {
    return isResizing;
  }

  watch(
    () => columnIndexes.value.join("\0"),
    () => initColumnWidths(),
  );
  watch([() => options.cacheKey?.value, options.columnStructureSignature], () => {
    columnWidths.value = [];
    previousColumnIndexes = [];
    userSizedColumnIndexes.clear();
    initColumnWidths();
  });
  watch([density, compactColumnHeaderActions, () => options.headerMeasurementKey?.value], () => {
    // Widths measured with different density or font metrics are unsafe to reuse.
    removeDataGridColumnWidthState(options.cacheKey?.value);
    initColumnWidths(true);
  });
  watch(neededColumnWidthSignature, () => growColumnWidthsToFitSamples(neededColumnWidths.value));

  return {
    columnWidths,
    initColumnWidths,
    growColumnWidthsToFitSamples,
    onResizeStart,
    autoFitColumn,
    renderedColumnWidths,
    totalWidth,
    columnVars,
    getIsResizing,
  };
}
