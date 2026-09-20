import type { CellValue } from "@/lib/dataGrid/cellValue";

export type DataGridReplacementMatch = { rowId: number; col: number; value: string };
export type DataGridCellReplacement = DataGridReplacementMatch & { previousValue: string; sourceValue?: string };
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

type PrepareCellReplacementsOptions = {
  matches: readonly DataGridReplacementMatch[];
  search: string;
  replacement: string;
  caseSensitive: boolean;
  needsResolution: (rowId: number, col: number) => boolean;
  resolveValues: (rowIds: number[], columnIndexes: number[]) => Promise<Map<number, Map<number, CellValue>>>;
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

export async function prepareDataGridCellReplacements(options: PrepareCellReplacementsOptions): Promise<DataGridCellReplacement[]> {
  if (!options.search || options.matches.length === 0) return [];
  const resolutionMatches = options.matches.filter((match) => options.needsResolution(match.rowId, match.col));
  const resolutionKeys = new Set(resolutionMatches.map((match) => `${match.rowId}:${match.col}`));
  const resolvedValues = resolutionMatches.length ? await options.resolveValues([...new Set(resolutionMatches.map((match) => match.rowId))], [...new Set(resolutionMatches.map((match) => match.col))]) : new Map<number, Map<number, CellValue>>();
  const pattern = dataGridReplacementPattern(options.search, options.caseSensitive);
  const replacements: DataGridCellReplacement[] = [];

  for (const match of options.matches) {
    const needsResolution = resolutionKeys.has(`${match.rowId}:${match.col}`);
    const resolvedRow = resolvedValues.get(match.rowId);
    if (needsResolution && !resolvedRow?.has(match.col)) continue;
    const previousValue = needsResolution ? resolvedRow?.get(match.col) : match.value;
    if (typeof previousValue !== "string") continue;
    pattern.lastIndex = 0;
    if (!pattern.test(previousValue)) continue;
    const value = replaceDataGridText(previousValue, options.search, options.replacement, options.caseSensitive);
    if (value === previousValue) continue;
    replacements.push({
      rowId: match.rowId,
      col: match.col,
      previousValue,
      value,
      ...(needsResolution ? { sourceValue: match.value } : {}),
    });
  }

  return replacements;
}
