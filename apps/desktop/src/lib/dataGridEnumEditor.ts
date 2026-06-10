import type { ColumnInfo } from "@/types/database";

/**
 * Check if the column's data_type is a MySQL ENUM type definition.
 * Matches patterns like `enum('value1','value2')` (case-insensitive).
 */
export function isEnumColumn(columnInfo: Pick<ColumnInfo, "data_type"> | undefined): boolean {
  if (!columnInfo?.data_type) return false;
  return /^enum\s*\(/i.test(columnInfo.data_type.trim());
}

/**
 * Parse MySQL ENUM values from a data_type string like `enum('a','b',...)`.
 * Handles escaped single quotes ('' → ').
 * Returns an empty array for unparseable input.
 */
export function enumValuesForColumn(columnInfo: Pick<ColumnInfo, "data_type"> | undefined): string[] {
  if (!isEnumColumn(columnInfo)) return [];
  const raw = columnInfo!.data_type.trim();
  const inner = raw.match(/^enum\s*\(\s*(.+?)\s*\)\s*$/is)?.[1];
  if (!inner) return [];

  const values: string[] = [];
  let i = 0;
  while (i < inner.length) {
    // Skip whitespace and commas between values
    while (i < inner.length && (inner[i] === " " || inner[i] === ",")) i++;
    if (i >= inner.length) break;

    if (inner[i] !== "'") break; // unexpected token

    i++; // skip opening quote
    let value = "";
    while (i < inner.length) {
      if (inner[i] === "'") {
        if (i + 1 < inner.length && inner[i + 1] === "'") {
          // Escaped single quote: ''
          value += "'";
          i += 2;
        } else {
          // Closing quote
          i++;
          break;
        }
      } else {
        value += inner[i];
        i++;
      }
    }
    values.push(value);
  }
  return values;
}
