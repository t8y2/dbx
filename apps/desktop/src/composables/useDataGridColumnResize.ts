import { ref, computed, type ComputedRef, type Ref } from "vue";
import { useElementSize } from "@vueuse/core";
import { calculateDataGridColumnWidth, DATA_GRID_COL_MIN_WIDTH, DATA_GRID_SAMPLE_ROWS } from "@/lib/dataGridColumnWidth";

type CellValue = string | number | boolean | null;

export const DATA_GRID_ROW_NUM_WIDTH = 48;

export interface UseDataGridColumnResizeOptions {
  columns: ComputedRef<string[]>;
  sourceRows: ComputedRef<CellValue[][]>;
  columnIndexes: ComputedRef<number[]>;
  gridRef: Ref<HTMLDivElement | undefined>;
  scrollbarGutter?: Ref<number>;
}

export function useDataGridColumnResize(options: UseDataGridColumnResizeOptions) {
  const { columns, sourceRows, columnIndexes, gridRef, scrollbarGutter } = options;

  const columnWidths = ref<number[]>([]);
  const { width: gridWidth } = useElementSize(gridRef);
  let isResizing = false;

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
    if (columnWidths.value.length !== columns.value.length) {
      columnWidths.value = columns.value.map((colName, colIdx) => {
        return calculateDataGridColumnWidth({
          columnName: colName,
          sampleValues: sampleColumnValues(colIdx),
        });
      });
    }
  }

  function onResizeStart(colIdx: number, event: MouseEvent) {
    event.preventDefault();
    isResizing = true;
    const startX = event.clientX;
    const startWidth = columnWidths.value[colIdx];
    const onMove = (e: MouseEvent) => {
      columnWidths.value[colIdx] = Math.max(DATA_GRID_COL_MIN_WIDTH, startWidth + e.clientX - startX);
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
    });
  }

  const baseTotalWidth = computed(() => columnWidths.value.reduce((a, b) => a + b, 0));

  const renderedColumnWidths = computed(() => {
    const widths = columnWidths.value;
    if (widths.length === 0) return widths;

    const availableWidth = Math.max(0, gridWidth.value - (scrollbarGutter?.value ?? 0));
    const extraWidth = Math.max(0, availableWidth - DATA_GRID_ROW_NUM_WIDTH - baseTotalWidth.value);
    if (extraWidth === 0) return widths;

    const extraPerColumn = extraWidth / widths.length;
    return widths.map((width) => width + extraPerColumn);
  });

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
