/**
 * Index metadata shape needed to decide whether a column is uniquely
 * constrained on its own. Mirrors the fields DBX returns from `listIndexes`.
 */
export interface UniqueConstraintIndex {
  columns: string[];
  is_unique: boolean;
  filter?: string | null;
  key_is_expression?: boolean[] | null;
}

/**
 * Columns that a full, single-column unique index (or single-column primary
 * key) constrains, so the data generator knows which columns cannot repeat a
 * value (#5958).
 *
 * Only indexes that guarantee per-column uniqueness qualify:
 * - Composite indexes are skipped: the table still accepts duplicate values in
 *   each participating column, so deduplicating a single column would be
 *   stricter than the real constraint and could exhaust a small value space.
 * - Partial indexes (`filter` set) are skipped for the same reason.
 * - Expression keys are skipped because they have no column name to match.
 */
export function uniqueConstraintColumns(indexes: readonly UniqueConstraintIndex[] | null | undefined): Set<string> {
  const columns = new Set<string>();
  for (const index of indexes ?? []) {
    if (!index.is_unique || index.filter) continue;
    if (index.columns.length !== 1) continue;
    const [column] = index.columns;
    if (!column || index.key_is_expression?.[0]) continue;
    columns.add(column);
  }
  return columns;
}
