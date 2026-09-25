import type { DatabaseType, QueryTab } from "@/types/database";
import type { EditorSettings } from "@/stores/settingsStore";
import { databaseSortSupportedForDatabase } from "@/lib/dataGrid/dataGridSort";
import { quoteTableDataIdentifier } from "@/lib/table/tableSelectSql";

export function resolveTableDefaultSort(settings: Pick<EditorSettings, "tableOpenSortMode" | "tableDatabaseSortDirection" | "tableLocalSortDirection">, databaseType: DatabaseType | undefined, physicalPrimaryKeys: string[], identifierQuote?: string) {
  const mode = settings.tableOpenSortMode ?? "none";
  const direction = (mode === "local" ? settings.tableLocalSortDirection : settings.tableDatabaseSortDirection) ?? "asc";
  const columns = databaseType === "influxdb" || databaseType === "influxdb3" ? [] : physicalPrimaryKeys;
  const orderBy = mode === "database" && columns.length && databaseSortSupportedForDatabase(databaseType) ? columns.map((column) => `${databaseType === "neo4j" ? "n." : ""}${quoteTableDataIdentifier(databaseType, column, identifierQuote)} ${direction.toUpperCase()}`).join(", ") : undefined;
  return { mode, direction, columns, orderBy };
}

export function applyTableDefaultSortResult(tab: QueryTab, sort: ReturnType<typeof resolveTableDefaultSort>, sortLocally: (id: string, column: string, index: number, direction: "asc" | "desc") => void) {
  if (!tab.result || tab.result.execution_error || tab.isExecuting) return;
  const column = sort.columns[0];
  const index = column ? tab.result.columns.indexOf(column) : -1;
  if (!column || index < 0) return;
  if (sort.orderBy) {
    tab.orderByInput = sort.orderBy;
    // A single-column grid indicator must not overwrite a composite ORDER BY.
    if (sort.columns.length === 1) {
      tab.resultSortColumn = column;
      tab.resultSortColumnIndex = index;
      tab.resultSortDirection = sort.direction;
      tab.resultSortMode = "database";
    }
  } else if (sort.mode === "local" && !tab.result.large_value_cells?.some((cell) => cell.column_index === index)) {
    sortLocally(tab.id, column, index, sort.direction);
  }
}
