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

/**
 * Resolve the data type used to drive per-column alignment and other
 * type-driven rendering in the query-result grid.
 *
 * Unlike {@link resolveHeaderColumnType}, the **ResultSet `column_types` wins
 * over table metadata** for alignment purposes.  Table metadata is matched by
 * the source column name and reflects the underlying column declaration, so
 * relying on it for alignment produces wrong results when the query casts the
 * value to a different type — e.g. `SELECT CAST(amount AS TEXT) AS amount`
 * would still look numeric and be right-aligned.  The actual ResultSet type
 * (`text`) reflects what the user sees and must take precedence.  Table
 * metadata is only consulted when the ResultSet does not supply a non-empty
 * type for that index.
 */
export interface ResultColumnTypeResolution {
  /** Type reported by the ResultSet for this column (by index). */
  resultColumnType?: string;
  /** Lower-cased name of the column in the ResultSet. */
  resultColumnName?: string;
  /** Lower-cased name of the underlying source column, when known. */
  sourceColumnName?: string;
  /** Map of lower-cased column name -> table metadata type. */
  tableColumnTypesByName?: ReadonlyMap<string, string>;
}

export function resolveResultColumnType({ resultColumnType, resultColumnName, sourceColumnName, tableColumnTypesByName }: ResultColumnTypeResolution): string | undefined {
  const fromResult = resultColumnType?.trim();
  if (fromResult) return fromResult;

  const lookup = tableColumnTypesByName ?? EMPTY_STRING_MAP;
  const fromSource = sourceColumnName ? lookup.get(sourceColumnName) : undefined;
  if (fromSource && fromSource.trim()) return fromSource;
  const fromResultName = resultColumnName ? lookup.get(resultColumnName) : undefined;
  return fromResultName && fromResultName.trim() ? fromResultName : undefined;
}

const EMPTY_STRING_MAP: ReadonlyMap<string, string> = new Map();
const TRANSPARENT_NUMERIC_TYPE_WRAPPERS = new Set(["nullable", "lowcardinality"]);

const NUMERIC_COLUMN_TYPE_BASES = new Set([
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "integer",
  "bigint",
  "serial",
  "smallserial",
  "bigserial",
  "int2",
  "int4",
  "int8",
  "int1",
  "int16",
  "int32",
  "int64",
  "int128",
  "int256",
  "intn",
  "uint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "uint128",
  "uint256",
  "float",
  "float4",
  "float8",
  "float16",
  "float32",
  "float64",
  "floatn",
  "real",
  "double",
  "decimal",
  "decimal32",
  "decimal64",
  "decimal128",
  "decimal256",
  "decimaln",
  "numeric",
  "numericn",
  "number",
  "dec",
  "fixed",
  "money",
  "money4",
  "moneyn",
  "smallmoney",
  "smallmoneyn",
  "binary_float",
  "binary_double",
]);

export function isNumericColumnType(dataType: string | undefined): boolean {
  if (!dataType) return false;
  let normalized = dataType.trim().toLowerCase();
  while (normalized.endsWith(")")) {
    const openIndex = normalized.indexOf("(");
    if (openIndex <= 0 || !TRANSPARENT_NUMERIC_TYPE_WRAPPERS.has(normalized.slice(0, openIndex).trim())) break;
    normalized = normalized.slice(openIndex + 1, -1).trim();
  }
  const base = normalized.split(/[\s([]/, 1)[0];
  return NUMERIC_COLUMN_TYPE_BASES.has(base);
}
