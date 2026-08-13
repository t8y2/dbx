import { displayCellValue, type CellValue } from "@/lib/dataGrid/cellValue";
import type { ColumnFormatterConfig } from "@/lib/dataGrid/columnFormatter";
import type { ForeignKeyAssociation } from "@/lib/dataGrid/dataGridForeignKeyNavigation";
import type { ForeignKeyInfo, QueryResult } from "@/types/database";

export type ForeignKeyDisplayConfig = Extract<ColumnFormatterConfig, { kind: "foreign-key-display" }>;

export const FOREIGN_KEY_DISPLAY_BATCH_SIZE = 500;
export const FOREIGN_KEY_DISPLAY_MAX_VALUES = 2000;

export function singleColumnForeignKey(association: ForeignKeyAssociation | null | undefined): ForeignKeyInfo | undefined {
  return association?.columnPairs.length === 1 ? association.foreignKey : undefined;
}

export function foreignKeyDisplayConfigMatches(config: ForeignKeyDisplayConfig, foreignKey: ForeignKeyInfo, currentSchema?: string): boolean {
  const expectedSchema = config.refSchema || currentSchema || "";
  const actualSchema = foreignKey.ref_schema || currentSchema || "";
  return config.refTable.toLowerCase() === foreignKey.ref_table.toLowerCase() && config.refColumn.toLowerCase() === foreignKey.ref_column.toLowerCase() && expectedSchema.toLowerCase() === actualSchema.toLowerCase();
}

export function foreignKeyDisplayValueKey(value: CellValue | undefined): string | undefined {
  if (value === null || value === undefined || typeof value === "object") return undefined;
  return `${typeof value}\u0000${String(value)}`;
}

export function collectForeignKeyDisplayValues(rows: QueryResult["rows"], columnIndex: number, maxValues = FOREIGN_KEY_DISPLAY_MAX_VALUES): CellValue[] {
  const values: CellValue[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const value = row[columnIndex] as CellValue | undefined;
    const key = foreignKeyDisplayValueKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    values.push(value!);
    if (values.length >= maxValues) break;
  }
  return values;
}

export function splitForeignKeyDisplayValues(values: readonly CellValue[], batchSize = FOREIGN_KEY_DISPLAY_BATCH_SIZE): CellValue[][] {
  if (batchSize <= 0) return [];
  const batches: CellValue[][] = [];
  for (let index = 0; index < values.length; index += batchSize) batches.push(values.slice(index, index + batchSize));
  return batches;
}

export function foreignKeyDisplayMapFromResult(result: QueryResult, keyColumn = result.columns[0], displayColumn = result.columns[1]): Map<string, string> {
  const map = new Map<string, string>();
  const keyIndex = result.columns.findIndex((column) => column.toLowerCase() === keyColumn?.toLowerCase());
  const displayIndex = result.columns.findIndex((column) => column.toLowerCase() === displayColumn?.toLowerCase());
  if (keyIndex < 0 || displayIndex < 0) return map;
  for (const row of result.rows) {
    const key = foreignKeyDisplayValueKey(row[keyIndex] as CellValue | undefined);
    const labelValue = row[displayIndex] as CellValue | undefined;
    if (!key || labelValue === null || labelValue === undefined || map.has(key)) continue;
    map.set(key, displayCellValue(labelValue));
  }
  return map;
}

export function formatForeignKeyDisplayValue(value: CellValue, labels: ReadonlyMap<string, string> | undefined): string {
  const raw = displayCellValue(value);
  const key = foreignKeyDisplayValueKey(value);
  const label = key ? labels?.get(key) : undefined;
  if (label === undefined || label === raw || !label.trim()) return raw;
  return `${raw} (${label})`;
}
