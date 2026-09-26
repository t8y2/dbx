import type { QueryResult } from "@/types/database";

/**
 * Rows read from a single target of a multi-database run. The merged view and
 * its Excel export need the query's body rather than just the editor's first
 * page, so every source is fetched up to this cap; the user's global result-row
 * limit still applies on top of it.
 */
export const MULTI_SOURCE_MAX_ROWS_PER_SOURCE = 10_000;

/**
 * Upper bound on merged rows. The merged view is a quick inspection surface, so
 * a fan-out over many connections must not be able to build an unbounded table;
 * hitting the cap is reported instead of silently dropping rows.
 */
export const MULTI_SOURCE_MERGE_MAX_ROWS = 50_000;

export type MultiSourceCellValue = string | number | boolean | null;

export interface MultiSourceResultInput {
  /** Stable identity of the contributing result (used as the row's origin key). */
  key: string;
  /** Human label written into the injected source column for every row. */
  label: string;
  result: QueryResult | undefined;
}

export interface MultiSourceMergeOptions {
  /** Header of the injected first column; localized by the caller. */
  sourceColumnLabel: string;
  maxRows?: number;
}

export interface MultiSourceColumnSummary {
  columnIndex: number;
  column: string;
  sum: number;
  /** Number of contributing values; empty cells never count. */
  count: number;
}

export interface MultiSourceMergeSource {
  key: string;
  label: string;
  rowCount: number;
  columnCount: number;
}

export interface MultiSourceMergeOutput {
  columns: string[];
  rows: MultiSourceCellValue[][];
  /** One entry per all-numeric column, aligned by column ordinal. */
  summaries: MultiSourceColumnSummary[];
  sources: MultiSourceMergeSource[];
  rowCount: number;
  truncated: boolean;
  /** Labels of inputs that carried no tabular payload and were left out. */
  skippedLabels: string[];
}

interface MergePlan {
  input: MultiSourceResultInput;
  result: QueryResult;
  /** Merged column ordinal for each source column ordinal. */
  targetIndexes: Map<number, number>;
}

function usableInput(input: MultiSourceResultInput): boolean {
  if (!input.result) return false;
  if (input.result.execution_error === true) return false;
  return (input.result.columns?.length ?? 0) > 0;
}

function mergedColumnName(column: string | undefined, sourceIndex: number): string {
  const name = typeof column === "string" ? column.trim() : "";
  return name === "" ? `column_${sourceIndex + 1}` : name;
}

function isEmptyCell(value: MultiSourceCellValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === "string" && value.trim() === "";
}

/**
 * A cell counts as numeric when it is a finite number or a non-empty string that
 * parses to one (drivers return DECIMAL/BIGINT as strings). Booleans are not
 * numeric, so a flag column never turns into a total.
 */
export function isNumericSummaryCellValue(value: MultiSourceCellValue | undefined): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed !== "" && Number.isFinite(Number(trimmed));
  }
  return false;
}

/**
 * Simple result-level aggregates: sums every column whose non-empty cells are
 * all numeric. A single non-numeric cell disqualifies the whole column, and a
 * column without values produces no total.
 */
export function summarizeNumericColumns(columns: readonly string[], rows: readonly (readonly MultiSourceCellValue[])[], options: { skipColumnIndexes?: readonly number[] } = {}): MultiSourceColumnSummary[] {
  const skipped = new Set(options.skipColumnIndexes ?? []);
  const sums: number[] = Array.from({ length: columns.length }, () => 0);
  const counts: number[] = Array.from({ length: columns.length }, () => 0);
  const stillNumeric: boolean[] = Array.from({ length: columns.length }, () => true);

  for (const row of rows) {
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      if (skipped.has(columnIndex) || !stillNumeric[columnIndex]) continue;
      const value = row[columnIndex];
      if (isEmptyCell(value)) continue;
      if (!isNumericSummaryCellValue(value)) {
        stillNumeric[columnIndex] = false;
        continue;
      }
      sums[columnIndex] += typeof value === "number" ? value : Number(value);
      counts[columnIndex] += 1;
    }
  }

  const summaries: MultiSourceColumnSummary[] = [];
  for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
    if (skipped.has(columnIndex) || !stillNumeric[columnIndex] || counts[columnIndex] === 0) continue;
    summaries.push({ columnIndex, column: columns[columnIndex] ?? "", sum: sums[columnIndex]!, count: counts[columnIndex]! });
  }
  return summaries;
}

/**
 * Merges the results of one query executed against several connections /
 * databases into a single table.
 *
 * Columns are aligned by name (union, first-seen order) and every row keeps a
 * leading provenance column naming the source it came from. A column a source
 * does not have is padded with null. Duplicate column names inside one result
 * keep their own value streams by matching the Nth occurrence of a name.
 */
export function mergeMultiSourceResults(inputs: readonly MultiSourceResultInput[], options: MultiSourceMergeOptions): MultiSourceMergeOutput {
  const maxRows = Math.max(1, Math.trunc(options.maxRows ?? MULTI_SOURCE_MERGE_MAX_ROWS));
  const columns: string[] = [options.sourceColumnLabel];
  // A merged column is identified by (name, occurrence-in-source) so duplicate
  // names in one result still keep both of their value streams.
  const indexByLayoutKey = new Map<string, number>();
  const plans: MergePlan[] = [];
  const skippedLabels: string[] = [];

  for (const input of inputs) {
    if (!usableInput(input)) {
      skippedLabels.push(input.label);
      continue;
    }
    const result = input.result!;
    const occurrences = new Map<string, number>();
    const targetIndexes = new Map<number, number>();
    const hiddenColumnIndexes = new Set(result.hidden_column_indexes ?? []);
    result.columns.forEach((column, sourceIndex) => {
      if (hiddenColumnIndexes.has(sourceIndex)) return;
      const name = mergedColumnName(column, sourceIndex);
      const occurrence = occurrences.get(name) ?? 0;
      occurrences.set(name, occurrence + 1);
      const layoutKey = `${name}\u0000${occurrence}`;
      let targetIndex = indexByLayoutKey.get(layoutKey);
      if (targetIndex === undefined) {
        targetIndex = columns.length;
        indexByLayoutKey.set(layoutKey, targetIndex);
        columns.push(name);
      }
      targetIndexes.set(sourceIndex, targetIndex);
    });
    plans.push({ input, result, targetIndexes });
  }

  const rows: MultiSourceCellValue[][] = [];
  let truncated = false;
  for (const plan of plans) {
    for (const sourceRow of plan.result.rows) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      const row: MultiSourceCellValue[] = Array.from({ length: columns.length }, () => null);
      row[0] = plan.input.label;
      plan.targetIndexes.forEach((targetIndex, sourceIndex) => {
        row[targetIndex] = sourceRow[sourceIndex] ?? null;
      });
      rows.push(row);
    }
    if (truncated) break;
  }

  return {
    columns,
    rows,
    // The injected provenance column is text by construction, but skip it
    // explicitly so a numeric-looking label can never become a total.
    summaries: summarizeNumericColumns(columns, rows, { skipColumnIndexes: [0] }),
    sources: plans.map((plan) => ({
      key: plan.input.key,
      label: plan.input.label,
      rowCount: plan.result.rows.length,
      columnCount: plan.targetIndexes.size,
    })),
    rowCount: rows.length,
    truncated,
    skippedLabels,
  };
}
