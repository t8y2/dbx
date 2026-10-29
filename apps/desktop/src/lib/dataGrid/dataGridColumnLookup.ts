import { identifierMatchScore } from "@/lib/sql/identifierSearch";

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

export function scoreDataGridColumnLookupItem(item: DataGridColumnLookupItem, query: string): number {
  const normalizedQuery = normalizedSearchText(query);
  if (!normalizedQuery) return 1;
  const nameScore = identifierMatchScore(item.name, normalizedQuery);
  const sourceScore = item.sourceName ? identifierMatchScore(item.sourceName, normalizedQuery) : -1;
  const commentScore = item.comment ? identifierMatchScore(item.comment, normalizedQuery) : -1;
  const effectiveCommentScore = commentScore >= 0 ? Math.max(0, commentScore - 50) : -1;
  return Math.max(nameScore, sourceScore, effectiveCommentScore);
}

export function filterDataGridColumnLookupItems<ColumnLookupItem extends DataGridColumnLookupItem>(items: readonly ColumnLookupItem[], query: string, matchMode: DataGridColumnLookupMatchMode = "fuzzy"): ColumnLookupItem[] {
  const normalizedQuery = normalizedSearchText(query);
  if (!normalizedQuery) return [...items];

  if (matchMode === "exact") {
    const normalizedQueryLower = normalizedQuery.toLocaleLowerCase();
    const scored: { item: ColumnLookupItem; score: number; order: number }[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const nameMatch = item.name.trim().toLocaleLowerCase() === normalizedQueryLower;
      const sourceMatch = item.sourceName?.trim().toLocaleLowerCase() === normalizedQueryLower;
      if (nameMatch || sourceMatch) {
        const score = nameMatch ? 2 : 1;
        scored.push({ item, score, order: i });
      }
    }
    return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((entry) => entry.item);
  }

  const scored: { item: ColumnLookupItem; score: number; order: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const score = scoreDataGridColumnLookupItem(item, normalizedQuery);
    if (score >= 0) {
      scored.push({ item, score, order: i });
    }
  }
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((entry) => entry.item);
}
