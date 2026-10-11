import { computed, ref, watch, type ComputedRef } from "vue";
import type { QueryResult } from "@/types/database";
import { projectNeo4jNodeResult } from "@/lib/neo4j/neo4jNodeResult";
import { sortDataGridRowIndexes, type DataGridSortDirection } from "@/lib/dataGrid/dataGridSort";

export function useNeo4jNodeTableResult(source: ComputedRef<QueryResult | undefined>, ownerKey: ComputedRef<string>) {
  const sort = ref<{ column: string; columnIndex: number; direction: DataGridSortDirection }>();
  watch(ownerKey, () => (sort.value = undefined));
  const projected = computed(() => (source.value ? projectNeo4jNodeResult(source.value) : undefined));
  const result = computed(() => {
    const result = projected.value;
    const state = sort.value;
    if (!result || !state || result.columns[state.columnIndex] !== state.column) return result;
    const indexes = sortDataGridRowIndexes(result.rows, state.columnIndex, state.direction, result.column_types?.[state.columnIndex]);
    const rowIndexMap = new Map(indexes.map((sourceIndex, targetIndex) => [sourceIndex, targetIndex]));
    return {
      ...result,
      rows: indexes.map((index) => result.rows[index]!),
      spatial_values: result.spatial_values ? indexes.map((index) => result.spatial_values![index]!) : undefined,
      large_value_cells: result.large_value_cells?.map((cell) => ({ ...cell, row_index: rowIndexMap.get(cell.row_index)! })),
      appended_from_row_count: undefined,
    };
  });
  function setSort(column: string, columnIndex: number, direction: DataGridSortDirection | null) {
    sort.value = direction ? { column, columnIndex, direction } : undefined;
  }
  return { result, sort, setSort };
}
