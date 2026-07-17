/**
 * Resolve the data type to display in a data-grid column header.
 *
 * Two sources can supply a column's type:
 *  - Table metadata (only when a table is open): matched **by column name**,
 *    richer because it carries precision/scale. Preferred.
 *  - `QueryResult.column_types` (any query): parallel to `result.columns`, so
 *    it must be read **by index**. Used as a fallback for arbitrary queries
 *    that have no table metadata (e.g. `select * from pg_depend`).
 *
 * Returns `undefined` when neither source has a non-empty type, so callers can
 * simply hide the type row.
 */
export interface HeaderColumnTypeSources {
  /** Type from table metadata for this column (looked up by name), if any. */
  tableColumnType?: string;
  /** `QueryResult.column_types`, parallel to `result.columns` (by index). */
  resultColumnTypes?: readonly string[];
  /** Index of the column within `result.columns`. */
  actualColIdx: number;
}

export function resolveHeaderColumnType({ tableColumnType, resultColumnTypes, actualColIdx }: HeaderColumnTypeSources): string | undefined {
  const fromMeta = tableColumnType?.trim();
  if (fromMeta) return fromMeta;

  const fromResult = resultColumnTypes?.[actualColIdx]?.trim();
  return fromResult ? fromResult : undefined;
}

export function compactHeaderColumnType(dataType: string): string {
  return /^enum\s*\(/i.test(dataType.trim()) ? "enum" : dataType;
}
