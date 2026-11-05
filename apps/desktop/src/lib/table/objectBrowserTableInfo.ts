type SearchableTableInfoColumn = {
  name: string;
  data_type: string;
  comment?: string | null;
};

export type ObjectBrowserTableColumnSortKey = "name" | "dataType" | "nullable" | "defaultValue";
export type ObjectBrowserTableColumnSortDirection = "asc" | "desc";
export type ObjectBrowserTableColumnSort = {
  key: ObjectBrowserTableColumnSortKey;
  direction: ObjectBrowserTableColumnSortDirection;
};

/** Keep table-info search aligned with the name, type, and comment text visible in the field list. */
export function filterObjectBrowserTableColumns<T extends SearchableTableInfoColumn>(columns: T[], query: string): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return columns;

  return columns.filter((column) => [column.name, column.data_type, column.comment].some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(normalizedQuery)));
}

type SortableTableInfoColumn = SearchableTableInfoColumn & {
  is_nullable: boolean;
  column_default: string | null;
};

/** Sort only the in-memory table-info presentation, preserving the source order for ties. */
export function sortObjectBrowserTableColumns<T extends SortableTableInfoColumn>(columns: T[], sort: ObjectBrowserTableColumnSort | null): T[] {
  if (!sort) return columns;

  return columns
    .map((column, index) => ({ column, index }))
    .sort((a, b) => {
      const left = a.column;
      const right = b.column;
      let result = 0;
      switch (sort.key) {
        case "name":
          result = compareTableInfoText(left.name, right.name);
          break;
        case "dataType":
          result = compareTableInfoText(left.data_type, right.data_type);
          break;
        case "nullable":
          result = Number(left.is_nullable) - Number(right.is_nullable);
          break;
        case "defaultValue":
          result = compareTableInfoNullableText(left.column_default, right.column_default);
          break;
      }
      return result === 0 ? a.index - b.index : sort.direction === "asc" ? result : -result;
    })
    .map(({ column }) => column);
}

function compareTableInfoText(left: string | null | undefined, right: string | null | undefined): number {
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true, sensitivity: "base" });
}

function compareTableInfoNullableText(left: string | null | undefined, right: string | null | undefined): number {
  const leftMissing = left == null;
  const rightMissing = right == null;
  if (leftMissing !== rightMissing) return leftMissing ? -1 : 1;
  return compareTableInfoText(left, right);
}
