import type { CellValue } from "@/lib/dataGrid/cellValue";

export type DataGridReplacementMatch = { rowId: number; col: number; value: string };
export type DataGridCellReplacement = DataGridReplacementMatch & { previousValue: string };
export type DataGridReplaceScope = "loaded" | "column" | "selection";

type ReplacementMatchOptions = {
  rows: readonly { rowId: number; data: readonly CellValue[] }[];
  search: string;
  caseSensitive?: boolean;
  column?: number;
  includesCell?: (rowId: number, col: number) => boolean;
  canReplaceCell?: (rowId: number, col: number) => boolean;
  isTruncated?: (rowId: number, col: number) => boolean;
};

export function dataGridReplacementPattern(search: string, caseSensitive: boolean): RegExp {
  return new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "gu" : "giu");
}

export function replaceDataGridText(value: string, search: string, replacement: string, caseSensitive: boolean): string {
  if (!search) return value;
  // A callback keeps $&, $1 and other replacement tokens literal.
  return value.replace(dataGridReplacementPattern(search, caseSensitive), () => replacement);
}

export function findDataGridReplacementMatches(options: ReplacementMatchOptions): DataGridReplacementMatch[] {
  if (!options.search) return [];
  const pattern = dataGridReplacementPattern(options.search, options.caseSensitive ?? false);
  const matches: DataGridReplacementMatch[] = [];
  for (const row of options.rows) {
    row.data.forEach((value, col) => {
      if (typeof value !== "string" || (options.column !== undefined && col !== options.column)) return;
      if (options.includesCell && !options.includesCell(row.rowId, col)) return;
      if (options.canReplaceCell && !options.canReplaceCell(row.rowId, col)) return;
      if (options.isTruncated?.(row.rowId, col)) return;
      pattern.lastIndex = 0;
      if (pattern.test(value)) matches.push({ rowId: row.rowId, col, value });
    });
  }
  return matches;
}
