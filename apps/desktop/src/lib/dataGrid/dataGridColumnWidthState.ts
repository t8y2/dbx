import type { ColumnWidthDensity } from "@/stores/settingsStore";

export const DATA_GRID_COLUMN_WIDTH_STATE_LIMIT = 128;

interface DataGridColumnWidthState {
  structureSignature: string;
  measurementSignature: string;
  widthsByColumnIndex: Map<number, number>;
}

interface DataGridColumnWidthStateIdentity {
  cacheKey?: string;
  structureSignature: string;
  measurementSignature: string;
}

const columnWidthStates = new Map<string, DataGridColumnWidthState>();

function touchColumnWidthState(cacheKey: string, state: DataGridColumnWidthState) {
  columnWidthStates.delete(cacheKey);
  columnWidthStates.set(cacheKey, state);
}

export function createDataGridColumnStructureSignature(columns: readonly string[], columnTypes?: readonly (string | undefined)[]): string {
  return JSON.stringify(columns.map((column, index) => [column, columnTypes?.[index] ?? ""]));
}

export function createDataGridColumnMeasurementSignature(density: ColumnWidthDensity, compactColumnHeaderActions: boolean, headerMeasurementKey: unknown): string {
  return JSON.stringify([density, compactColumnHeaderActions, headerMeasurementKey ?? null]);
}

export function loadDataGridColumnWidthState(identity: DataGridColumnWidthStateIdentity, columnIndexes: readonly number[]): Array<number | undefined> | undefined {
  const cacheKey = identity.cacheKey?.trim();
  if (!cacheKey) return undefined;
  const state = columnWidthStates.get(cacheKey);
  if (!state) return undefined;
  if (state.structureSignature !== identity.structureSignature || state.measurementSignature !== identity.measurementSignature) {
    columnWidthStates.delete(cacheKey);
    return undefined;
  }
  touchColumnWidthState(cacheKey, state);
  return columnIndexes.map((columnIndex) => state.widthsByColumnIndex.get(columnIndex));
}

export function saveDataGridColumnWidthState(identity: DataGridColumnWidthStateIdentity, columnIndexes: readonly number[], widths: readonly number[]) {
  const cacheKey = identity.cacheKey?.trim();
  if (!cacheKey || columnIndexes.length !== widths.length) return;
  const existing = columnWidthStates.get(cacheKey);
  const widthsByColumnIndex = existing?.structureSignature === identity.structureSignature && existing.measurementSignature === identity.measurementSignature ? new Map(existing.widthsByColumnIndex) : new Map<number, number>();
  columnIndexes.forEach((columnIndex, visibleIndex) => {
    const width = widths[visibleIndex];
    if (Number.isFinite(width)) widthsByColumnIndex.set(columnIndex, width);
  });
  touchColumnWidthState(cacheKey, {
    structureSignature: identity.structureSignature,
    measurementSignature: identity.measurementSignature,
    widthsByColumnIndex,
  });
  // Query result keys are session-scoped, so bound the in-memory cache instead of relying on store cleanup paths.
  while (columnWidthStates.size > DATA_GRID_COLUMN_WIDTH_STATE_LIMIT) {
    const oldestCacheKey = columnWidthStates.keys().next().value;
    if (oldestCacheKey === undefined) break;
    columnWidthStates.delete(oldestCacheKey);
  }
}

export function removeDataGridColumnWidthState(cacheKey?: string) {
  const normalizedCacheKey = cacheKey?.trim();
  if (normalizedCacheKey) columnWidthStates.delete(normalizedCacheKey);
}

export function clearDataGridColumnWidthStates() {
  columnWidthStates.clear();
}

export function dataGridColumnWidthStateCount(): number {
  return columnWidthStates.size;
}
