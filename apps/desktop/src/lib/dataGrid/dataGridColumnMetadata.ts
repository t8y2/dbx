import type { ColumnInfo } from "@/types/database";

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
