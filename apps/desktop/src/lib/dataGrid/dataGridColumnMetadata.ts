import type { ColumnInfo } from "@/types/database";

export type DataGridColumnNullability = "nullable" | "required";

export function resolveDataGridColumnNullability(context: "results" | "table-data" | undefined, column: Pick<ColumnInfo, "is_nullable"> | undefined): DataGridColumnNullability | undefined {
  if (context !== "results" || !column) return undefined;
  return column.is_nullable ? "nullable" : "required";
}

export function resolveDataGridColumnsByResultIndex(options: { resultColumns: readonly string[]; sourceColumns?: readonly (string | undefined)[]; tableColumns: readonly ColumnInfo[] }): Array<ColumnInfo | undefined> {
  const columnsByName = new Map<string, ColumnInfo>();
  for (const column of options.tableColumns) {
    const key = column.name.toLowerCase();
    if (!columnsByName.has(key)) columnsByName.set(key, column);
  }
  return options.resultColumns.map((resultColumn, index) => {
    const columnName = options.sourceColumns?.[index] ?? resultColumn;
    return columnName ? columnsByName.get(columnName.toLowerCase()) : undefined;
  });
}
