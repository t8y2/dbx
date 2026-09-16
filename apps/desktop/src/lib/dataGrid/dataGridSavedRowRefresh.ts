import type { CellValue } from "@/lib/dataGrid/cellValue";

export const DATA_GRID_SAVED_ROW_REFRESH_LIMIT = 100;

export type DataGridSavedRowRefreshIneligibleReason = "not-table-data" | "infinite-scroll" | "active-filter" | "active-order" | "too-many-rows" | "missing-identity" | "missing-identity-column" | "identity-edited" | "missing-source-row" | "duplicate-identity";

export interface DataGridSavedRowRefreshPlan {
  sourceIndexes: number[];
  identityColumns: string[];
  identityColumnIndexes: number[];
  identityKeys: string[];
}

export type DataGridSavedRowRefreshPlanResult = { eligible: true; plan: DataGridSavedRowRefreshPlan } | { eligible: false; reason: DataGridSavedRowRefreshIneligibleReason };

export interface BuildDataGridSavedRowRefreshPlanOptions {
  context?: "results" | "table-data";
  infiniteScroll: boolean;
  filterActive: boolean;
  orderActive: boolean;
  columns: readonly string[];
  sourceColumns?: readonly (string | undefined)[];
  rows: readonly (readonly CellValue[])[];
  primaryKeys: readonly string[];
  dirtyRows: ReadonlyMap<number, ReadonlyMap<number, CellValue>>;
  rowLimit?: number;
}

export interface DataGridSavedRowRefreshPatch {
  sourceIndex: number;
  refreshedRowIndex: number;
  row: CellValue[];
}

function normalizeColumnName(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? "";
}

function resolveColumnIndexes(columns: readonly string[], sourceColumns: readonly (string | undefined)[] | undefined, targets: readonly string[]): number[] | null {
  const indexes = targets.map((target) => {
    const normalizedTarget = normalizeColumnName(target);
    const sourceIndex = sourceColumns?.findIndex((column) => normalizeColumnName(column) === normalizedTarget) ?? -1;
    if (sourceIndex >= 0) return sourceIndex;
    return columns.findIndex((column, index) => !normalizeColumnName(sourceColumns?.[index]) && normalizeColumnName(column) === normalizedTarget);
  });
  return indexes.every((index) => index >= 0) ? indexes : null;
}

function serializeCellValue(value: CellValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${value.length}:${value}`;
  if (typeof value === "boolean") return value ? "boolean:1" : "boolean:0";
  if (Number.isNaN(value)) return "number:NaN";
  if (Object.is(value, -0)) return "number:-0";
  return `number:${String(value)}`;
}

export function dataGridSavedRowIdentityKey(row: readonly CellValue[], identityColumnIndexes: readonly number[]): string {
  return identityColumnIndexes.map((index) => serializeCellValue(row[index] ?? null)).join("\u0000");
}

export function buildDataGridSavedRowRefreshPlan(options: BuildDataGridSavedRowRefreshPlanOptions): DataGridSavedRowRefreshPlanResult {
  if (options.context !== "table-data") return { eligible: false, reason: "not-table-data" };
  if (options.infiniteScroll) return { eligible: false, reason: "infinite-scroll" };
  if (options.filterActive) return { eligible: false, reason: "active-filter" };
  if (options.orderActive) return { eligible: false, reason: "active-order" };
  if (options.dirtyRows.size > (options.rowLimit ?? DATA_GRID_SAVED_ROW_REFRESH_LIMIT)) return { eligible: false, reason: "too-many-rows" };
  if (options.primaryKeys.length === 0) return { eligible: false, reason: "missing-identity" };

  const identityColumnIndexes = resolveColumnIndexes(options.columns, options.sourceColumns, options.primaryKeys);
  if (!identityColumnIndexes) return { eligible: false, reason: "missing-identity-column" };
  const identityIndexSet = new Set(identityColumnIndexes);
  const sourceIndexes: number[] = [];
  const identityKeys: string[] = [];
  const seenIdentityKeys = new Set<string>();

  for (const [sourceIndex, changes] of options.dirtyRows) {
    if ([...changes.keys()].some((columnIndex) => identityIndexSet.has(columnIndex))) return { eligible: false, reason: "identity-edited" };
    const row = options.rows[sourceIndex];
    if (!row) return { eligible: false, reason: "missing-source-row" };
    const identityKey = dataGridSavedRowIdentityKey(row, identityColumnIndexes);
    if (seenIdentityKeys.has(identityKey)) return { eligible: false, reason: "duplicate-identity" };
    seenIdentityKeys.add(identityKey);
    sourceIndexes.push(sourceIndex);
    identityKeys.push(identityKey);
  }

  return {
    eligible: true,
    plan: {
      sourceIndexes,
      identityColumns: [...options.primaryKeys],
      identityColumnIndexes,
      identityKeys,
    },
  };
}

function refreshedColumnMapping(columns: readonly string[], sourceColumns: readonly (string | undefined)[] | undefined, refreshedColumns: readonly string[]): number[] | null {
  if (columns.length === refreshedColumns.length && columns.every((column, index) => normalizeColumnName(sourceColumns?.[index] ?? column) === normalizeColumnName(refreshedColumns[index]))) {
    return columns.map((_, index) => index);
  }

  const usedIndexes = new Set<number>();
  const mapping = columns.map((column, index) => {
    const target = normalizeColumnName(sourceColumns?.[index] ?? column);
    const refreshedIndex = refreshedColumns.findIndex((candidate, candidateIndex) => !usedIndexes.has(candidateIndex) && normalizeColumnName(candidate) === target);
    if (refreshedIndex >= 0) usedIndexes.add(refreshedIndex);
    return refreshedIndex;
  });
  return mapping.every((index) => index >= 0) ? mapping : null;
}

export function dataGridSavedRowRefreshPatches(plan: DataGridSavedRowRefreshPlan, columns: readonly string[], sourceColumns: readonly (string | undefined)[] | undefined, refreshedColumns: readonly string[], refreshedRows: readonly (readonly CellValue[])[]): DataGridSavedRowRefreshPatch[] | null {
  const refreshedIdentityIndexes = resolveColumnIndexes(refreshedColumns, undefined, plan.identityColumns);
  const columnMapping = refreshedColumnMapping(columns, sourceColumns, refreshedColumns);
  if (!refreshedIdentityIndexes || !columnMapping) return null;

  const refreshedRowsByIdentity = new Map<string, { refreshedRowIndex: number; row: readonly CellValue[] }>();
  for (const [refreshedRowIndex, row] of refreshedRows.entries()) {
    const identityKey = dataGridSavedRowIdentityKey(row, refreshedIdentityIndexes);
    if (refreshedRowsByIdentity.has(identityKey)) return null;
    refreshedRowsByIdentity.set(identityKey, { refreshedRowIndex, row });
  }
  if (refreshedRowsByIdentity.size !== plan.identityKeys.length) return null;

  const patches: DataGridSavedRowRefreshPatch[] = [];
  for (let index = 0; index < plan.identityKeys.length; index++) {
    const refreshed = refreshedRowsByIdentity.get(plan.identityKeys[index]!);
    if (!refreshed) return null;
    patches.push({
      sourceIndex: plan.sourceIndexes[index]!,
      refreshedRowIndex: refreshed.refreshedRowIndex,
      row: columnMapping.map((columnIndex) => refreshed.row[columnIndex] ?? null),
    });
  }
  return patches;
}
