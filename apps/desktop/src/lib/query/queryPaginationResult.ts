import type { QueryResult } from "@/types/database";

/** Remove only the trailing helper identified by the pagination plan. */
export function stripPaginationRowNumber(result: QueryResult, column: string | undefined): QueryResult {
  const index = result.columns.length - 1;
  if (!column || index < 0 || result.columns[index] !== column) return result;
  return {
    ...result,
    columns: result.columns.slice(0, index),
    rows: result.rows.map((row) => row.slice(0, index)),
    column_types: result.column_types?.slice(0, index),
    column_sortables: result.column_sortables?.slice(0, index),
    spatial_values: result.spatial_values?.map((row) => row.slice(0, index)),
    spatial_columns: result.spatial_columns?.filter((column) => column.column_index < index),
    large_value_cells: result.large_value_cells?.filter((cell) => cell.column_index < index),
    hidden_column_indexes: result.hidden_column_indexes?.filter((columnIndex) => columnIndex < index),
  };
}
