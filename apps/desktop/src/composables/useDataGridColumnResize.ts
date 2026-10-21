import { ref, shallowRef, computed, watch, type ComputedRef, type Ref } from "vue";
import { calculateDataGridColumnWidth, DATA_GRID_AUTO_FIT_VALUE_TEXT_LIMIT, DATA_GRID_COL_AUTO_FIT_MAX_WIDTH, DATA_GRID_COL_MIN_WIDTH, COLUMN_WIDTH_DENSITY_PRESETS, sampleDataGridColumnValues } from "@/lib/dataGrid/dataGridColumnWidth";
import { createDataGridColumnMeasurementSignature, loadDataGridColumnWidthState, removeDataGridColumnWidthState, saveDataGridColumnWidthState } from "@/lib/dataGrid/dataGridColumnWidthState";
import type { ColumnWidthDensity, DataGridColumnWidthMode } from "@/stores/settingsStore";

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
  widthMode: Ref<DataGridColumnWidthMode>;
  compactColumnHeaderActions: ComputedRef<boolean>;
  columnIndexIndicators?: ComputedRef<readonly boolean[]>;
  cacheKey?: ComputedRef<string | undefined>;
  columnStructureSignature: ComputedRef<string>;
  measureHeaderText?: (text: string) => number | undefined;
  headerMeasurementKey?: Ref<unknown>;
  rowNumberWidth?: Ref<number> | ComputedRef<number>;
  viewportWidth?: Ref<number> | ComputedRef<number>;
  displayValue?: (value: CellValue, columnIndex: number) => CellValue;
}

export function useDataGridColumnResize(options: UseDataGridColumnResizeOptions) {
  const { columns, sourceRows, columnIndexes, density, compactColumnHeaderActions, measureHeaderText } = options;

  const columnWidths = ref<number[]>([]);
  let isResizing = false;
  let previousColumnIndexes: number[] = [];
  // User manual drag/input vs auto-calculated (default or auto-fit).
  // Only manual widths survive font metrics/density changes and persist across sessions.
  const manualColumnIndexes = shallowRef<Set<number>>(new Set());
  const autoFittedColumnIndexes = shallowRef<Set<number>>(new Set());

  function columnWidthStateIdentity() {
    return {
      cacheKey: options.cacheKey?.value,
      structureSignature: options.columnStructureSignature.value,
      measurementSignature: createDataGridColumnMeasurementSignature(density.value, compactColumnHeaderActions.value, options.headerMeasurementKey?.value),
    };
  }

  function persistColumnWidths() {
    saveDataGridColumnWidthState(columnWidthStateIdentity(), previousColumnIndexes, columnWidths.value, manualColumnIndexes.value, autoFittedColumnIndexes.value);
  }

  function sampleColumnValues(visibleColIdx: number): CellValue[] {
    const actualColIdx = columnIndexes.value[visibleColIdx];
    if (actualColIdx === undefined) return [];
    const preset = COLUMN_WIDTH_DENSITY_PRESETS[density.value];
    const values = sampleDataGridColumnValues(sourceRows.value, actualColIdx, preset.sampleRows);
    return options.displayValue ? values.map((value) => options.displayValue!(value, actualColIdx)) : values;
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
      hasIndexIndicator: options.columnIndexIndicators?.value[colIdx] ?? false,
    });
  }

  const neededColumnWidths = computed(() => (columns.value ?? []).map((_, colIdx) => neededColumnWidth(colIdx)));
  const neededColumnWidthSignature = computed(() => neededColumnWidths.value.join("|"));

  /** Grow-only: late pages with larger keys must not stay stuck at a short-header / early-page width. */
  function growColumnWidthsToFitSamples(neededWidths = neededColumnWidths.value) {
    if (columnWidths.value.length !== columns.value.length || columns.value.length === 0) return;
    let grew = false;
    const next = columnWidths.value.slice();
    for (let colIdx = 0; colIdx < columns.value.length; colIdx++) {
      const actualColIdx = columnIndexes.value[colIdx];
      if (actualColIdx === undefined || manualColumnIndexes.value.has(actualColIdx) || autoFittedColumnIndexes.value.has(actualColIdx)) continue;
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

  function markColumnManualSized(visibleColIdx: number) {
    const actualColIdx = columnIndexes.value[visibleColIdx];
    if (actualColIdx === undefined) return;
    if (autoFittedColumnIndexes.value.has(actualColIdx)) {
      const nextAuto = new Set(autoFittedColumnIndexes.value);
      nextAuto.delete(actualColIdx);
      autoFittedColumnIndexes.value = nextAuto;
    }
    if (!manualColumnIndexes.value.has(actualColIdx)) {
      const nextManual = new Set(manualColumnIndexes.value);
      nextManual.add(actualColIdx);
      manualColumnIndexes.value = nextManual;
    }
  }

  function markColumnAutoFitted(visibleColIdx: number) {
    const actualColIdx = columnIndexes.value[visibleColIdx];
    if (actualColIdx === undefined) return;
    if (manualColumnIndexes.value.has(actualColIdx)) {
      const nextManual = new Set(manualColumnIndexes.value);
      nextManual.delete(actualColIdx);
      manualColumnIndexes.value = nextManual;
    }
    if (!autoFittedColumnIndexes.value.has(actualColIdx)) {
      const nextAuto = new Set(autoFittedColumnIndexes.value);
      nextAuto.add(actualColIdx);
      autoFittedColumnIndexes.value = nextAuto;
    }
  }

  function initColumnWidths(force = false) {
    if (force) {
      manualColumnIndexes.value = new Set();
      autoFittedColumnIndexes.value = new Set();
    }
    const previousWidthsByColumnIndex = new Map<number, number>();
    previousColumnIndexes.forEach((columnIndex, visibleIndex) => {
      const width = columnWidths.value[visibleIndex];
      if (width !== undefined) previousWidthsByColumnIndex.set(columnIndex, width);
    });
    const nextColumnIndexes = [...columnIndexes.value];
    const cachedState = !force && previousColumnIndexes.length === 0 ? loadDataGridColumnWidthState(columnWidthStateIdentity(), nextColumnIndexes) : undefined;
    if (cachedState) {
      manualColumnIndexes.value = new Set(cachedState.userSizedColumnIndexes);
      autoFittedColumnIndexes.value = new Set(cachedState.autoFittedColumnIndexes ?? []);
    }
    const currentNeededWidths = neededColumnWidths.value ?? [];
    const columnCount = columns.value?.length ?? 0;
    if (force || columnWidths.value.length !== columnCount || previousColumnIndexes.join("\0") !== nextColumnIndexes.join("\0")) {
      columnWidths.value = (columns.value ?? []).map((_, colIdx) => {
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
    // The drag base is the width the user grabbed, which may include spare width
    // distributed at render time. Freezing that snapshot as the stored width and
    // marking the column user-sized right away keeps the column out of the
    // flexible set for the whole drag, so every frame renders startWidth + delta
    // as-is instead of re-stretching it with the remaining surplus, and the
    // stored (persisted) width matches what the cursor moved.
    const startWidth = renderedColumnWidths.value[colIdx] ?? DATA_GRID_COL_MIN_WIDTH;
    markColumnManualSized(colIdx);
    columnWidths.value[colIdx] = startWidth;
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
      markColumnManualSized(colIdx);
      persistColumnWidths();
      requestAnimationFrame(() => {
        isResizing = false;
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  /** Full-content width of one visible column: unlike the default grow-only
   *  sizing this ignores the density value truncation, so long text columns are
   *  sized for what the cell actually shows. */
  function autoFitColumnWidth(colIdx: number): number | undefined {
    const colName = columns.value[colIdx];
    if (!colName) return undefined;
    return calculateDataGridColumnWidth({
      columnName: colName,
      sampleValues: sampleColumnValues(colIdx),
      maxWidth: DATA_GRID_COL_AUTO_FIT_MAX_WIDTH,
      valueTextLimit: DATA_GRID_AUTO_FIT_VALUE_TEXT_LIMIT,
      density: density.value,
      compactColumnHeaderActions: compactColumnHeaderActions.value,
      includeValues: true,
      headerTextWidth: measureHeaderText?.(colName),
      hasIndexIndicator: options.columnIndexIndicators?.value[colIdx] ?? false,
    });
  }

  function autoFitColumn(colIdx: number) {
    const width = autoFitColumnWidth(colIdx);
    if (width === undefined) return;
    columnWidths.value[colIdx] = width;
    markColumnAutoFitted(colIdx);
    persistColumnWidths();
  }

  /** Fit every visible column to its content in one action (issue #9813), so a
   *  wide table does not need one double-click per column. Manual drag keeps
   *  working afterwards: the fitted columns are recorded as user-sized, which is
   *  exactly the state a drag leaves behind. */
  function autoFitAllColumns() {
    if (columnWidths.value.length !== columns.value.length || columns.value.length === 0) return;
    const next = columnWidths.value.slice();
    let changed = false;
    for (let colIdx = 0; colIdx < columns.value.length; colIdx++) {
      const width = autoFitColumnWidth(colIdx);
      if (width === undefined) continue;
      markColumnAutoFitted(colIdx);
      if (next[colIdx] !== width) {
        next[colIdx] = width;
        changed = true;
      }
    }
    if (changed) columnWidths.value = next;
    persistColumnWidths();
  }

  const resolvedRowNumberWidth = computed(() => options.rowNumberWidth?.value ?? DATA_GRID_ROW_NUM_WIDTH);

  const renderedColumnWidths = computed(() => {
    const widths = columnWidths.value.slice();
    if (options.widthMode.value === "content") return widths;
    const viewportWidth = options.viewportWidth?.value ?? 0;
    const surplus = viewportWidth - resolvedRowNumberWidth.value - widths.reduce((sum, width) => sum + width, 0);
    if (surplus <= 0) return widths;
    const flexibleIndexes = widths.flatMap((_, visibleIndex) => {
      const actualIndex = columnIndexes.value[visibleIndex];
      return actualIndex !== undefined && !manualColumnIndexes.value.has(actualIndex) && !autoFittedColumnIndexes.value.has(actualIndex) ? [visibleIndex] : [];
    });
    if (flexibleIndexes.length === 0) return widths;
    const base = Math.floor(surplus / flexibleIndexes.length);
    let remainder = surplus - base * flexibleIndexes.length;
    flexibleIndexes.forEach((index) => {
      widths[index] += base + (remainder-- > 0 ? 1 : 0);
    });
    return widths;
  });

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
    manualColumnIndexes.value = new Set();
    autoFittedColumnIndexes.value = new Set();
    initColumnWidths();
  });
  function recomputeAutoColumnWidths() {
    if (columnWidths.value.length === 0) {
      initColumnWidths();
      return;
    }
    const nextColumnIndexes = [...columnIndexes.value];
    const currentNeededWidths = neededColumnWidths.value ?? [];
    autoFittedColumnIndexes.value = new Set();
    columnWidths.value = (columns.value ?? []).map((_, colIdx) => {
      const actualColIdx = nextColumnIndexes[colIdx];
      if (actualColIdx !== undefined && manualColumnIndexes.value.has(actualColIdx)) {
        const existingWidth = columnWidths.value[colIdx];
        if (existingWidth !== undefined) return existingWidth;
      }
      return currentNeededWidths[colIdx] ?? DATA_GRID_COL_MIN_WIDTH;
    });
    previousColumnIndexes = nextColumnIndexes;
    growColumnWidthsToFitSamples(currentNeededWidths);
    if (manualColumnIndexes.value.size > 0) {
      persistColumnWidths();
    } else {
      removeDataGridColumnWidthState(options.cacheKey?.value);
    }
  }

  watch([density, compactColumnHeaderActions, () => options.headerMeasurementKey?.value], () => {
    // Font metrics and density changes invalidate only auto-calculated column widths.
    // User-sized column widths represent explicit pixel choices and must be preserved.
    recomputeAutoColumnWidths();
  });
  watch(neededColumnWidthSignature, () => growColumnWidthsToFitSamples(neededColumnWidths.value));

  return {
    columnWidths,
    initColumnWidths,
    growColumnWidthsToFitSamples,
    onResizeStart,
    autoFitColumn,
    autoFitAllColumns,
    renderedColumnWidths,
    totalWidth,
    columnVars,
    getIsResizing,
  };
}
