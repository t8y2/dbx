import type { CellValue } from "@/lib/dataGrid/cellValue";
import type { ColumnInfo } from "@/types/database";

export interface DataGridNewRowPlaceholderRow {
  data: readonly CellValue[];
  isNew: boolean;
  isDraft?: boolean;
}

export function resolveDataGridNewRowCellPlaceholder(options: { row: DataGridNewRowPlaceholderRow | undefined; columnIndex: number; column: Pick<ColumnInfo, "column_default"> | undefined; draftFallback: string }): string | null {
  const { row, columnIndex, column, draftFallback } = options;
  if (!row || (!row.isNew && !row.isDraft) || row.data[columnIndex] !== null) return null;

  const rawDefault = column?.column_default;
  if (rawDefault != null) {
    const normalizedDefault = rawDefault.trim();
    if (normalizedDefault && normalizedDefault.toUpperCase() !== "NULL") return rawDefault;
  }

  return row.isDraft ? draftFallback : null;
}
