import type { DataGridLocalFilterOption } from "@/lib/dataGrid/dataGridLocalColumnFilterState";
import { dataGridLocalFilterKey } from "@/lib/dataGrid/dataGridLocalColumnFilterState";
import type { CellValue } from "@/lib/dataGrid/cellValue";
import type { DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";
import type { ColumnInfo } from "@/types/database";

export type DataGridDistinctValueSuggestionTarget = "value" | "end";
export type DataGridDistinctValueSource = "database" | "page";

export interface DataGridDistinctValueSuggestionState {
  ruleId?: string;
  target?: DataGridDistinctValueSuggestionTarget;
  source?: DataGridDistinctValueSource;
  search: string;
  options: DataGridLocalFilterOption[];
  loading: boolean;
  error: string;
  limited: boolean;
  limit: number;
  selectedKeys: Set<string>;
  canUseServerFilter?: boolean;
}

export function dataGridDistinctValueKey(value: CellValue, columnInfo?: Pick<ColumnInfo, "data_type">): string {
  const typeParts = (columnInfo?.data_type ?? "").toLowerCase().split(/[^a-z0-9]+/);
  if (typeParts.some((part) => ["int", "integer", "bigint", "smallint", "tinyint", "mediumint", "serial", "number", "numeric", "decimal", "float", "double", "real", "money"].includes(part))) return `num:${String(value)}`;
  return dataGridLocalFilterKey(value);
}

/**
 * Filter modes whose meaning is "everything except this value". Picking NULL out
 * of the value list has to keep that negation, so these map to `is-not-null`.
 *
 * The `satisfies` clause breaks compilation when the union gains a mode that the
 * list and the comment above were not reconsidered for (#14365 review).
 */
const NEGATED_DATA_GRID_FILTER_MODES = ["not-equals", "not-like", "not-between", "not-begins-with", "not-ends-with"] as const satisfies readonly DataGridContextFilterMode[];

export function dataGridNullSuggestionFilterMode(mode: DataGridContextFilterMode): "is-null" | "is-not-null" {
  return (NEGATED_DATA_GRID_FILTER_MODES as readonly DataGridContextFilterMode[]).includes(mode) ? "is-not-null" : "is-null";
}

export function toggleAllDataGridDistinctValueOptions(selectedValues: ReadonlyMap<string, CellValue>, options: readonly DataGridLocalFilterOption[]): Map<string, CellValue> {
  const next = new Map(selectedValues);
  if (!options.length) return next;

  const allSelected = options.every((option) => next.has(option.key));
  for (const option of options) {
    if (allSelected) next.delete(option.key);
    else next.set(option.key, option.value);
  }
  return next;
}
