import { ref, computed, watch, type ComputedRef, type Ref } from "vue";
import { calculateDataGridColumnWidth, DATA_GRID_AUTO_FIT_VALUE_TEXT_LIMIT, DATA_GRID_COL_AUTO_FIT_MAX_WIDTH, DATA_GRID_COL_MIN_WIDTH, COLUMN_WIDTH_DENSITY_PRESETS } from "@/lib/dataGrid/dataGridColumnWidth";
import { createDataGridColumnMeasurementSignature, loadDataGridColumnWidthState, removeDataGridColumnWidthState, saveDataGridColumnWidthState } from "@/lib/dataGrid/dataGridColumnWidthState";
import type { ColumnWidthDensity } from "@/stores/settingsStore";

type CellValue = string | number | boolean | null;

export const DATA_GRID_ROW_NUM_WIDTH = 48;

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
}

export function useDataGridColumnResize(options: UseDataGridColumnResizeOptions) {
  const { columns, sourceRows, columnIndexes, density, compactColumnHeaderActions, measureHeaderText } = options;

  const columnWidths = ref<number[]>([]);
  let isResizing = false;
  let previousColumnIndexes: number[] = [];

  function columnWidthStateIdentity() {
    return {
      cacheKey: options.cacheKey?.value,
      structureSignature: options.columnStructureSignature.value,
      measurementSignature: createDataGridColumnMeasurementSignature(density.value, compactColumnHeaderActions.value, options.headerMeasurementKey?.value),
    };
  }

  function persistColumnWidths() {
    saveDataGridColumnWidthState(columnWidthStateIdentity(), previousColumnIndexes, columnWidths.value);
  }

  function sampleColumnValues(visibleColIdx: number): CellValue[] {
    const actualColIdx = columnIndexes.value[visibleColIdx];
    const rows = sourceRows.value;
    const preset = COLUMN_WIDTH_DENSITY_PRESETS[density.value];
    const end = Math.min(rows.length, preset.sampleRows);
    const values: CellValue[] = [];
    for (let i = 0; i < end; i++) {
      values.push(rows[i][actualColIdx] ?? null);
    }
    return values;
  }

  function initColumnWidths(force = false) {
    const previousWidthsByColumnIndex = new Map<number, number>();
    previousColumnIndexes.forEach((columnIndex, visibleIndex) => {
      const width = columnWidths.value[visibleIndex];
      if (width !== undefined) previousWidthsByColumnIndex.set(columnIndex, width);
    });
    const nextColumnIndexes = [...columnIndexes.value];
    const cachedWidths = !force && previousColumnIndexes.length === 0 ? loadDataGridColumnWidthState(columnWidthStateIdentity(), nextColumnIndexes) : undefined;
    if (force || columnWidths.value.length !== columns.value.length || previousColumnIndexes.join("\0") !== nextColumnIndexes.join("\0")) {
      columnWidths.value = columns.value.map((colName, colIdx) => {
        if (!force) {
          const existingWidth = previousWidthsByColumnIndex.get(nextColumnIndexes[colIdx]);
          if (existingWidth !== undefined) return existingWidth;
          const cachedWidth = cachedWidths?.[colIdx];
          if (cachedWidth !== undefined) return cachedWidth;
        }
        return calculateDataGridColumnWidth({
          columnName: colName,
          sampleValues: sampleColumnValues(colIdx),
          density: density.value,
          compactColumnHeaderActions: compactColumnHeaderActions.value,
          headerTextWidth: measureHeaderText?.(colName),
        });
      });
    }
    previousColumnIndexes = nextColumnIndexes;
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
    persistColumnWidths();
  }

  const renderedColumnWidths = computed(() => columnWidths.value.slice());

  const totalWidth = computed(() => renderedColumnWidths.value.reduce((a, b) => a + b, 0) + DATA_GRID_ROW_NUM_WIDTH);

  const columnVars = computed(() => {
    const vars: Record<string, string> = {};
    renderedColumnWidths.value.forEach((w, i) => {
      vars[`--col-w-${i}`] = `${w}px`;
    });
    vars["--row-num-w"] = `${DATA_GRID_ROW_NUM_WIDTH}px`;
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
    initColumnWidths();
  });
  watch([density, compactColumnHeaderActions, () => options.headerMeasurementKey?.value], () => {
    // Widths measured with different density or font metrics are unsafe to reuse.
    removeDataGridColumnWidthState(options.cacheKey?.value);
    initColumnWidths(true);
  });

  return {
    columnWidths,
    initColumnWidths,
    onResizeStart,
    autoFitColumn,
    renderedColumnWidths,
    totalWidth,
    columnVars,
    getIsResizing,
  };
}
