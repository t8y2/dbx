import type { CellValue } from "@/lib/dataGrid/cellValue";
import type { QueryResult } from "@/types/database";

/** Internal read identity is based on original keys, never interpreted display text. */
export function createResultKeyLocator(result: QueryResult, indexes: readonly number[], requireRaw: boolean, unavailableMessage: string) {
  const keys = new Map<string, CellValue>();
  const duplicates = new Set<string>();
  for (const cell of result.raw_key_cells ?? []) {
    const key = `${cell.row_index}:${cell.column_index}`;
    if (keys.has(key)) duplicates.add(key);
    keys.set(key, cell.value);
  }
  function values(rowIndex: number): CellValue[] {
    const row = result.rows[rowIndex];
    if (!row || indexes.length === 0 || new Set(indexes).size !== indexes.length) throw new Error(unavailableMessage);
    return indexes.map((index) => {
      if (index < 0 || index >= row.length) throw new Error(unavailableMessage);
      if (!requireRaw) return row[index] ?? null;
      const key = `${rowIndex}:${index}`;
      if (!keys.has(key) || duplicates.has(key)) throw new Error(unavailableMessage);
      return keys.get(key)!;
    });
  }
  return {
    values,
    // JSON tuples preserve boundaries and types, even when displayed keys collide.
    identity: (rowIndex: number) => JSON.stringify(values(rowIndex)),
  };
}

/** Restore source order after sorting without reviving already hydrated previews. */
export function originalResultRowOrder(result: QueryResult, originalRows: QueryResult["rows"], originalKeys: QueryResult["raw_key_cells"]): number[] | undefined {
  if (!originalKeys?.length || result.rows.length !== originalRows.length) return undefined;
  const indexes = [...new Set(originalKeys.map((cell) => cell.column_index))].sort((a, b) => a - b);
  const current = createResultKeyLocator(result, indexes, true, "unavailable");
  const original = createResultKeyLocator({ ...result, rows: originalRows, raw_key_cells: originalKeys }, indexes, true, "unavailable");
  try {
    const byIdentity = new Map<string, number>();
    for (let index = 0; index < result.rows.length; index++) {
      const identity = current.identity(index);
      if (byIdentity.has(identity)) return undefined;
      byIdentity.set(identity, index);
    }
    const order = originalRows.map((_, index) => byIdentity.get(original.identity(index)));
    if (order.some((index) => index === undefined) || new Set(order).size !== originalRows.length) return undefined;
    return order as number[];
  } catch {
    // Incomplete/ambiguous keys cannot have been used for successful hydration.
    return undefined;
  }
}
