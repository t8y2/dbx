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
  const match = raw.match(/^enum\s*\(/i);
  if (!match) return [];

  const values: string[] = [];
  let i = match[0].length;
  while (i < raw.length) {
    // MySQL may append CHARACTER SET/COLLATE after the enum value list.
    if (raw[i] === ")") {
      i++;
      return i >= raw.length || /\s/.test(raw[i]) ? values : [];
    }

    while (i < raw.length && (/\s/.test(raw[i]) || raw[i] === ",")) i++;
    if (i >= raw.length) break;
    if (raw[i] === ")") continue;

    if (raw[i] !== "'") return [];

    i++;
    let value = "";
    let closed = false;
    while (i < raw.length) {
      if (raw[i] === "'") {
        if (i + 1 < raw.length && raw[i + 1] === "'") {
          value += "'";
          i += 2;
        } else {
          i++;
          closed = true;
          break;
        }
      } else {
        value += raw[i];
        i++;
      }
    }
    if (!closed) return [];
    values.push(value);
  }
  return [];
}
