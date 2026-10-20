import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import type { ColumnWidthDensity } from "@/stores/settingsStore";

export const DATA_GRID_COLUMN_WIDTH_STATE_LIMIT = 128;
const STORAGE_PREFIX = "dbx-data-grid-column-widths:";
const STORAGE_INDEX_KEY = "dbx-data-grid-column-widths-index";

interface DataGridColumnWidthState {
  structureSignature: string;
  measurementSignature: string;
  widthsByColumnIndex: Map<number, number>;
  userSizedColumnIndexes: Set<number>;
}

interface StoredDataGridColumnWidthState {
  version: number;
  structureSignature: string;
  measurementSignature: string;
  widths: Array<[number, number]>;
  userSizedColumnIndexes: number[];
}

interface DataGridColumnWidthStateIdentity {
  cacheKey?: string;
  structureSignature: string;
  measurementSignature: string;
}

export interface DataGridColumnWidthStateSnapshot {
  widths: Array<number | undefined>;
  userSizedColumnIndexes: Set<number>;
}

const columnWidthStates = new Map<string, DataGridColumnWidthState>();

function touchColumnWidthState(cacheKey: string, state: DataGridColumnWidthState) {
  columnWidthStates.delete(cacheKey);
  columnWidthStates.set(cacheKey, state);
}

function loadStorageIndex(): string[] {
  const raw = safeLocalStorageGet(STORAGE_INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

function saveStorageIndex(index: string[]) {
  safeLocalStorageSet(STORAGE_INDEX_KEY, JSON.stringify(index));
}

function touchStorageKey(cacheKey: string) {
  const index = loadStorageIndex().filter((key) => key !== cacheKey);
  index.push(cacheKey);
  while (index.length > DATA_GRID_COLUMN_WIDTH_STATE_LIMIT) {
    const oldest = index.shift();
    if (oldest) safeLocalStorageRemove(`${STORAGE_PREFIX}${oldest}`);
  }
  saveStorageIndex(index);
}

function removeStorageKey(cacheKey: string) {
  const index = loadStorageIndex().filter((key) => key !== cacheKey);
  saveStorageIndex(index);
  safeLocalStorageRemove(`${STORAGE_PREFIX}${cacheKey}`);
}

function loadPersistentDataGridColumnWidthState(cacheKey: string): DataGridColumnWidthState | undefined {
  const raw = safeLocalStorageGet(`${STORAGE_PREFIX}${cacheKey}`);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredDataGridColumnWidthState>;
    if (parsed.version !== 1 || typeof parsed.structureSignature !== "string" || typeof parsed.measurementSignature !== "string" || !Array.isArray(parsed.widths) || !Array.isArray(parsed.userSizedColumnIndexes)) {
      removeStorageKey(cacheKey);
      return undefined;
    }
    const widthsByColumnIndex = new Map<number, number>();
    for (const entry of parsed.widths) {
      if (Array.isArray(entry) && typeof entry[0] === "number" && typeof entry[1] === "number" && Number.isFinite(entry[1])) {
        widthsByColumnIndex.set(entry[0], entry[1]);
      }
    }
    const userSizedColumnIndexes = new Set<number>();
    for (const index of parsed.userSizedColumnIndexes) {
      if (typeof index === "number") userSizedColumnIndexes.add(index);
    }
    touchStorageKey(cacheKey);
    return {
      structureSignature: parsed.structureSignature,
      measurementSignature: parsed.measurementSignature,
      widthsByColumnIndex,
      userSizedColumnIndexes,
    };
  } catch {
    removeStorageKey(cacheKey);
    return undefined;
  }
}

function savePersistentDataGridColumnWidthState(cacheKey: string, state: DataGridColumnWidthState) {
  const payload: StoredDataGridColumnWidthState = {
    version: 1,
    structureSignature: state.structureSignature,
    measurementSignature: state.measurementSignature,
    widths: Array.from(state.widthsByColumnIndex.entries()),
    userSizedColumnIndexes: Array.from(state.userSizedColumnIndexes),
  };
  safeLocalStorageSet(`${STORAGE_PREFIX}${cacheKey}`, JSON.stringify(payload));
  touchStorageKey(cacheKey);
}

function removePersistentDataGridColumnWidthState(cacheKey: string) {
  removeStorageKey(cacheKey);
}

function clearPersistentDataGridColumnWidthStates() {
  const index = loadStorageIndex();
  for (const key of index) {
    safeLocalStorageRemove(`${STORAGE_PREFIX}${key}`);
  }
  safeLocalStorageRemove(STORAGE_INDEX_KEY);
}

export function createDataGridColumnStructureSignature(columns: readonly string[], columnTypes?: readonly (string | undefined)[]): string {
  return JSON.stringify(columns.map((column, index) => [column, columnTypes?.[index] ?? ""]));
}

export function createDataGridColumnMeasurementSignature(density: ColumnWidthDensity, compactColumnHeaderActions: boolean, headerMeasurementKey: unknown): string {
  return JSON.stringify([density, compactColumnHeaderActions, headerMeasurementKey ?? null]);
}

export function loadDataGridColumnWidthState(identity: DataGridColumnWidthStateIdentity, columnIndexes: readonly number[]): DataGridColumnWidthStateSnapshot | undefined {
  const cacheKey = identity.cacheKey?.trim();
  if (!cacheKey) return undefined;
  let state = columnWidthStates.get(cacheKey);
  if (!state) {
    state = loadPersistentDataGridColumnWidthState(cacheKey);
    if (state) {
      columnWidthStates.set(cacheKey, state);
    }
  }
  if (!state) return undefined;
  if (state.structureSignature !== identity.structureSignature || state.measurementSignature !== identity.measurementSignature) {
    columnWidthStates.delete(cacheKey);
    removePersistentDataGridColumnWidthState(cacheKey);
    return undefined;
  }
  touchColumnWidthState(cacheKey, state);
  return {
    widths: columnIndexes.map((columnIndex) => state.widthsByColumnIndex.get(columnIndex)),
    userSizedColumnIndexes: new Set(state.userSizedColumnIndexes),
  };
}

export function saveDataGridColumnWidthState(identity: DataGridColumnWidthStateIdentity, columnIndexes: readonly number[], widths: readonly number[], userSizedColumnIndexes: ReadonlySet<number>) {
  const cacheKey = identity.cacheKey?.trim();
  if (!cacheKey || columnIndexes.length !== widths.length) return;
  const existing = columnWidthStates.get(cacheKey) ?? loadPersistentDataGridColumnWidthState(cacheKey);
  const widthsByColumnIndex = existing?.structureSignature === identity.structureSignature && existing.measurementSignature === identity.measurementSignature ? new Map(existing.widthsByColumnIndex) : new Map<number, number>();
  const nextUserSizedColumnIndexes = existing?.structureSignature === identity.structureSignature && existing.measurementSignature === identity.measurementSignature ? new Set(existing.userSizedColumnIndexes) : new Set<number>();
  columnIndexes.forEach((columnIndex, visibleIndex) => {
    const width = widths[visibleIndex];
    if (Number.isFinite(width)) widthsByColumnIndex.set(columnIndex, width);
    if (userSizedColumnIndexes.has(columnIndex)) nextUserSizedColumnIndexes.add(columnIndex);
    else nextUserSizedColumnIndexes.delete(columnIndex);
  });
  const nextState: DataGridColumnWidthState = {
    structureSignature: identity.structureSignature,
    measurementSignature: identity.measurementSignature,
    widthsByColumnIndex,
    userSizedColumnIndexes: nextUserSizedColumnIndexes,
  };
  touchColumnWidthState(cacheKey, nextState);
  if (nextUserSizedColumnIndexes.size > 0) {
    savePersistentDataGridColumnWidthState(cacheKey, nextState);
  } else {
    removePersistentDataGridColumnWidthState(cacheKey);
  }
  while (columnWidthStates.size > DATA_GRID_COLUMN_WIDTH_STATE_LIMIT) {
    const oldestCacheKey = columnWidthStates.keys().next().value;
    if (oldestCacheKey === undefined) break;
    columnWidthStates.delete(oldestCacheKey);
  }
}

export function removeDataGridColumnWidthState(cacheKey?: string) {
  const normalizedCacheKey = cacheKey?.trim();
  if (normalizedCacheKey) {
    columnWidthStates.delete(normalizedCacheKey);
    removePersistentDataGridColumnWidthState(normalizedCacheKey);
  }
}

export function clearDataGridColumnWidthStates() {
  columnWidthStates.clear();
  clearPersistentDataGridColumnWidthStates();
}

export function dataGridColumnWidthStateCount(): number {
  return columnWidthStates.size;
}
