import { ref } from "vue";
import type { DataGridSortColumn, DataGridSortDirection, DataGridSortMode } from "@/lib/dataGrid/dataGridSort";

export function useDataGridSort() {
  const sortColumn = ref<string | null>(null);
  const sortColumnIndex = ref<number | null>(null);
  const sortDirection = ref<DataGridSortDirection>("asc");
  const sortMode = ref<DataGridSortMode>("local");
  const sortColumns = ref<DataGridSortColumn[]>([]);

  function setSort(column: string | null, columnIndex: number | null, direction: DataGridSortDirection, mode: DataGridSortMode) {
    sortColumn.value = column;
    sortColumnIndex.value = columnIndex;
    sortDirection.value = direction;
    sortMode.value = mode;
    sortColumns.value = column !== null && columnIndex !== null ? [{ column, columnIndex, direction }] : [];
  }

  function setSortColumns(columns: readonly DataGridSortColumn[], mode: DataGridSortMode = "local") {
    const first = columns[0];
    setSort(first?.column ?? null, first?.columnIndex ?? null, first?.direction ?? "asc", mode);
    sortColumns.value = columns.slice();
  }

  function clearSort() {
    setSort(null, null, "asc", "local");
  }

  return {
    sortColumn,
    sortColumnIndex,
    sortDirection,
    sortMode,
    sortColumns,
    setSortColumns,
    setSort,
    clearSort,
  };
}
