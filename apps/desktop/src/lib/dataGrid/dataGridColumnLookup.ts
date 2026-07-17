export interface DataGridColumnLookupItem {
  index: number;
  name: string;
  sourceName?: string;
  comment?: string;
}

export interface DataGridColumnLookupOptions {
  columns: readonly string[];
  sourceColumns?: readonly (string | undefined)[];
  displayableIndexes?: readonly number[];
  commentByColumn?: ReadonlyMap<string, string>;
}

function normalizedSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
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
    const comment = dataGridColumnCommentFor(options.commentByColumn, name, sourceName);
    return {
      index,
      name,
      ...(sourceName ? { sourceName } : {}),
      ...(comment ? { comment } : {}),
    };
  });
}

export function filterDataGridColumnLookupItems(items: readonly DataGridColumnLookupItem[], query: string): DataGridColumnLookupItem[] {
  const normalizedQuery = normalizedSearchText(query);
  if (!normalizedQuery) return [...items];
  return items.filter((item) => [item.name, item.sourceName, item.comment].filter((value): value is string => !!value).some((value) => value.toLocaleLowerCase().includes(normalizedQuery)));
}
