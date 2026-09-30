import type { DataGridLocalFilterOption } from "@/lib/dataGrid/dataGridLocalColumnFilterState";
import { dataGridLocalFilterKey } from "@/lib/dataGrid/dataGridLocalColumnFilterState";
import type { CellValue } from "@/lib/dataGrid/cellValue";
import type { DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";
import type { ColumnInfo } from "@/types/database";

export type DataGridDistinctValueSuggestionTarget = "value" | "end";

export interface DataGridDistinctValueSuggestionState {
  ruleId?: string;
  target?: DataGridDistinctValueSuggestionTarget;
  search: string;
  options: DataGridLocalFilterOption[];
  loading: boolean;
  error: string;
  limited: boolean;
  limit: number;
  selectedKeys: Set<string>;
}

export function dataGridDistinctValueKey(value: CellValue, columnInfo?: Pick<ColumnInfo, "data_type">): string {
  const typeParts = (columnInfo?.data_type ?? "").toLowerCase().split(/[^a-z0-9]+/);
  if (typeParts.some((part) => ["int", "integer", "bigint", "smallint", "tinyint", "mediumint", "serial", "number", "numeric", "decimal", "float", "double", "real", "money"].includes(part))) return `num:${String(value)}`;
  return dataGridLocalFilterKey(value);
}

export function dataGridNullSuggestionFilterMode(mode: DataGridContextFilterMode): "is-null" | "is-not-null" {
  return mode === "not-equals" || mode === "not-like" || mode === "not-between" ? "is-not-null" : "is-null";
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
