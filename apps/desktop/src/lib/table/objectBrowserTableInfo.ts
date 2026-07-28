type SearchableTableInfoColumn = {
  name: string;
  data_type: string;
  comment?: string | null;
};

/** Keep table-info search aligned with the name, type, and comment text visible in the field list. */
export function filterObjectBrowserTableColumns<T extends SearchableTableInfoColumn>(columns: T[], query: string): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return columns;

  return columns.filter((column) => [column.name, column.data_type, column.comment].some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(normalizedQuery)));
}
