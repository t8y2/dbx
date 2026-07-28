import { ref } from "vue";
import type { DataGridSortDirection, DataGridSortMode } from "@/lib/dataGrid/dataGridSort";

export function useDataGridSort() {
  const sortColumn = ref<string | null>(null);
  const sortColumnIndex = ref<number | null>(null);
  const sortDirection = ref<DataGridSortDirection>("asc");
  const sortMode = ref<DataGridSortMode>("database");

  function setSort(column: string | null, columnIndex: number | null, direction: DataGridSortDirection, mode: DataGridSortMode) {
    sortColumn.value = column;
    sortColumnIndex.value = columnIndex;
    sortDirection.value = direction;
    sortMode.value = mode;
  }

  function clearSort() {
    setSort(null, null, "asc", "database");
  }

  return {
    sortColumn,
    sortColumnIndex,
    sortDirection,
    sortMode,
    setSort,
    clearSort,
  };
}
