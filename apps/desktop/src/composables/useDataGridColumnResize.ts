import { ref, computed, watch, type ComputedRef } from "vue";
import { calculateDataGridColumnWidth, DATA_GRID_AUTO_FIT_VALUE_TEXT_LIMIT, DATA_GRID_COL_AUTO_FIT_MAX_WIDTH, DATA_GRID_COL_MIN_WIDTH, DATA_GRID_SAMPLE_ROWS } from "@/lib/dataGrid/dataGridColumnWidth";

type CellValue = string | number | boolean | null;

export const DATA_GRID_ROW_NUM_WIDTH = 48;

export function resizeDataGridColumnWidth(startWidth: number, deltaX: number): number {
  return Math.max(DATA_GRID_COL_MIN_WIDTH, startWidth + deltaX);
}

export interface UseDataGridColumnResizeOptions {
  columns: ComputedRef<string[]>;
  sourceRows: ComputedRef<CellValue[][]>;
  columnIndexes: ComputedRef<number[]>;
}

export function useDataGridColumnResize(options: UseDataGridColumnResizeOptions) {
  const { columns, sourceRows, columnIndexes } = options;

  const columnWidths = ref<number[]>([]);
  let isResizing = false;
  let previousColumnIndexes: number[] = [];

  function sampleColumnValues(visibleColIdx: number): CellValue[] {
    const actualColIdx = columnIndexes.value[visibleColIdx];
    const rows = sourceRows.value;
    const end = Math.min(rows.length, DATA_GRID_SAMPLE_ROWS);
    const values: CellValue[] = [];
    for (let i = 0; i < end; i++) {
      values.push(rows[i][actualColIdx] ?? null);
    }
    return values;
  }

  function initColumnWidths() {
    const previousWidthsByColumnIndex = new Map<number, number>();
    previousColumnIndexes.forEach((columnIndex, visibleIndex) => {
      const width = columnWidths.value[visibleIndex];
      if (width !== undefined) previousWidthsByColumnIndex.set(columnIndex, width);
    });
    const nextColumnIndexes = [...columnIndexes.value];
    if (columnWidths.value.length !== columns.value.length || previousColumnIndexes.join("\0") !== nextColumnIndexes.join("\0")) {
      columnWidths.value = columns.value.map((colName, colIdx) => {
        const existingWidth = previousWidthsByColumnIndex.get(nextColumnIndexes[colIdx]);
        if (existingWidth !== undefined) return existingWidth;
        return calculateDataGridColumnWidth({
          columnName: colName,
          sampleValues: sampleColumnValues(colIdx),
        });
      });
    }
    previousColumnIndexes = nextColumnIndexes;
  }

  function onResizeStart(colIdx: number, event: MouseEvent) {
    event.preventDefault();
    isResizing = true;
    const startX = event.clientX;
    const startWidth = columnWidths.value[colIdx];
    const onMove = (e: MouseEvent) => {
      columnWidths.value[colIdx] = resizeDataGridColumnWidth(startWidth, e.clientX - startX);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
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
    });
  }

  const renderedColumnWidths = computed(() => columnWidths.value);

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

  watch(() => columnIndexes.value.join("\0"), initColumnWidths);

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
