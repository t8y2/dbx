import { normalizeResultPageSize } from "@/lib/dataGrid/paginationPageSize";
import { tableOpenPageLimit } from "@/lib/table/tableOpenPageLimit";

export type DataGridPageSizePreference = "results" | "table-open";

type DataGridContext = "results" | "table-data" | undefined;
type DataGridPageSizeSettings = {
  pageSize: unknown;
  tableOpenPageSize: unknown;
};

export function resolveDataGridPageSizePreference(context: DataGridContext, preference?: DataGridPageSizePreference): DataGridPageSizePreference {
  return preference ?? (context === "table-data" ? "table-open" : "results");
}

export function preferredDataGridPageSize(settings: DataGridPageSizeSettings, preference: DataGridPageSizePreference, pageLimit?: number): number {
  return preference === "table-open" ? normalizeResultPageSize(pageLimit ?? tableOpenPageLimit(settings.tableOpenPageSize)) : normalizeResultPageSize(settings.pageSize);
}

export function dataGridPageSizeSettingsPatch(preference: DataGridPageSizePreference, value: unknown): { pageSize: number } | { tableOpenPageSize: number } {
  const normalized = normalizeResultPageSize(value);
  return preference === "table-open" ? { tableOpenPageSize: normalized } : { pageSize: normalized };
}
