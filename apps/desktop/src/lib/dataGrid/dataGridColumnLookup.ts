import { matchesIdentifierSearch } from "@/lib/sql/identifierSearch";

export interface DataGridColumnLookupItem {
  index: number;
  name: string;
  sourceName?: string;
  comment?: string;
}

export interface DataGridColumnLookupOptions {
  columns: readonly string[];
  sourceColumns?: readonly (string | undefined)[];
  columnComments?: readonly (string | undefined)[];
  displayableIndexes?: readonly number[];
  commentByColumn?: ReadonlyMap<string, string>;
}

export type DataGridColumnLookupMatchMode = "fuzzy" | "exact";

function normalizedSearchText(value: string): string {
  return value.trim();
}

function nonEmptyComment(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function dataGridColumnCommentFor(commentByColumn: ReadonlyMap<string, string> | undefined, columnName: string, sourceName?: string): string | undefined {
  if (!commentByColumn) return undefined;
  const keys = [sourceName, sourceName?.toLocaleLowerCase(), columnName, columnName.toLocaleLowerCase()].filter((value): value is string => !!value);
  for (const key of keys) {
    const comment = nonEmptyComment(commentByColumn.get(key));
    if (comment) return comment;
  }
  return undefined;
}

export function buildDataGridColumnLookupItems(options: DataGridColumnLookupOptions): DataGridColumnLookupItem[] {
  const indexes = options.displayableIndexes ?? options.columns.map((_, index) => index);
  return indexes.map((index) => {
    const name = options.columns[index] ?? `#${index + 1}`;
    const sourceName = options.sourceColumns?.[index];
    // A present ordinal array owns unresolved entries too; falling back by
    // name there could leak another source's comment onto an aggregate/alias.
    const comment = options.columnComments === undefined ? dataGridColumnCommentFor(options.commentByColumn, name, sourceName) : nonEmptyComment(options.columnComments[index]);
    return {
      index,
      name,
      ...(sourceName ? { sourceName } : {}),
      ...(comment ? { comment } : {}),
    };
  });
}

export function filterDataGridColumnLookupItems<ColumnLookupItem extends DataGridColumnLookupItem>(items: readonly ColumnLookupItem[], query: string, matchMode: DataGridColumnLookupMatchMode = "fuzzy"): ColumnLookupItem[] {
  const normalizedQuery = normalizedSearchText(query);
  if (!normalizedQuery) return [...items];
  if (matchMode === "exact") {
    const normalizedQueryLower = normalizedQuery.toLocaleLowerCase();
    return items.filter((item) => [item.name, item.sourceName].filter((value): value is string => !!value).some((value) => value.trim().toLocaleLowerCase() === normalizedQueryLower));
  }
  return items.filter((item) => [item.name, item.sourceName, item.comment].filter((value): value is string => !!value).some((value) => matchesIdentifierSearch(value, normalizedQuery)));
}
