import { dataGridSearchMatchKey, type CanvasDataGridRow } from "@/lib/dataGrid/canvasDataGridRenderer";
import type { CellValue } from "@/lib/dataGrid/cellValue";

export type ColumnHighlightRule = {
  duplicates?: boolean;
  nulls?: boolean;
};

export function isColumnDuplicateHighlightActive(rules: ReadonlyMap<number, ColumnHighlightRule>, columnIndex: number): boolean {
  return rules.get(columnIndex)?.duplicates === true;
}

export function isColumnNullHighlightActive(rules: ReadonlyMap<number, ColumnHighlightRule>, columnIndex: number): boolean {
  return rules.get(columnIndex)?.nulls === true;
}

export function hasColumnHighlight(rules: ReadonlyMap<number, ColumnHighlightRule>, columnIndex: number): boolean {
  const rule = rules.get(columnIndex);
  return rule ? rule.duplicates === true || rule.nulls === true : false;
}

export function hasAnyColumnHighlight(rules: ReadonlyMap<number, ColumnHighlightRule>): boolean {
  for (const rule of rules.values()) {
    if (rule.duplicates || rule.nulls) return true;
  }
  return false;
}

export function setColumnDuplicateHighlight(rules: Map<number, ColumnHighlightRule>, columnIndex: number, active: boolean): void {
  const current = rules.get(columnIndex) ?? {};
  if (active) {
    rules.set(columnIndex, { ...current, duplicates: true });
  } else {
    if (current.nulls) {
      rules.set(columnIndex, { nulls: true });
    } else {
      rules.delete(columnIndex);
    }
  }
}

export function setColumnNullHighlight(rules: Map<number, ColumnHighlightRule>, columnIndex: number, active: boolean): void {
  const current = rules.get(columnIndex) ?? {};
  if (active) {
    rules.set(columnIndex, { ...current, nulls: true });
  } else {
    if (current.duplicates) {
      rules.set(columnIndex, { duplicates: true });
    } else {
      rules.delete(columnIndex);
    }
  }
}

export function toggleColumnDuplicateHighlight(rules: Map<number, ColumnHighlightRule>, columnIndex: number): boolean {
  const next = !isColumnDuplicateHighlightActive(rules, columnIndex);
  setColumnDuplicateHighlight(rules, columnIndex, next);
  return next;
}

export function toggleColumnNullHighlight(rules: Map<number, ColumnHighlightRule>, columnIndex: number): boolean {
  const next = !isColumnNullHighlightActive(rules, columnIndex);
  setColumnNullHighlight(rules, columnIndex, next);
  return next;
}

export function clearColumnHighlight(rules: Map<number, ColumnHighlightRule>, columnIndex: number): void {
  rules.delete(columnIndex);
}

export function clearAllColumnHighlights(rules: Map<number, ColumnHighlightRule>): void {
  rules.clear();
}

function cellValueDuplicateKey(value: unknown): unknown {
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return value;
}

export interface ColumnHighlightMatches {
  duplicateKeys: Set<number>;
  nullKeys: Set<number>;
}

export function computeColumnHighlightMatchKeys(options: { rows: readonly CanvasDataGridRow[]; rules: ReadonlyMap<number, ColumnHighlightRule>; isNullValue?: (value: CellValue) => boolean }): ColumnHighlightMatches {
  const { rows, rules, isNullValue } = options;
  const duplicateKeys = new Set<number>();
  const nullKeys = new Set<number>();

  if (rules.size === 0 || rows.length === 0) {
    return { duplicateKeys, nullKeys };
  }

  const checkNull = (val: CellValue): boolean => {
    return (isNullValue ? isNullValue(val) : val === null) || val === undefined;
  };

  for (const [colIndex, rule] of rules.entries()) {
    if (!rule.duplicates && !rule.nulls) continue;

    if (rule.nulls) {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row) continue;
        const value = row.data[colIndex];
        if (checkNull(value)) {
          nullKeys.add(dataGridSearchMatchKey(row.displayIndex, colIndex));
        }
      }
    }

    if (rule.duplicates) {
      const counts = new Map<unknown, number>();
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row) continue;
        const value = row.data[colIndex];
        if (checkNull(value)) continue;
        const key = cellValueDuplicateKey(value);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row) continue;
        const value = row.data[colIndex];
        if (checkNull(value)) continue;
        const key = cellValueDuplicateKey(value);
        if ((counts.get(key) ?? 0) > 1) {
          duplicateKeys.add(dataGridSearchMatchKey(row.displayIndex, colIndex));
        }
      }
    }
  }

  return { duplicateKeys, nullKeys };
}
