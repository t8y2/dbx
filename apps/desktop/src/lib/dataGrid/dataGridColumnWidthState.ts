import { safeLocalStorageGet, safeLocalStorageKeys, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import type { ColumnWidthDensity } from "@/stores/settingsStore";

export const DATA_GRID_COLUMN_WIDTH_STATE_LIMIT = 128;
const STORAGE_PREFIX = "dbx-data-grid-column-widths:";
const STORAGE_INDEX_KEY = "dbx-data-grid-column-widths-index";

interface DataGridColumnWidthState {
  structureSignature: string;
  measurementSignature: string;
  widthsByColumnIndex: Map<number, number>;
  userSizedColumnIndexes: Set<number>;
  autoFittedColumnIndexes?: Set<number>;
}

interface StoredDataGridColumnWidthState {
  version: number;
  structureSignature: string;
  measurementSignature: string;
  widths: Array<[number, number]>;
  userSizedColumnIndexes: number[];
  autoFittedColumnIndexes?: number[];
}

interface DataGridColumnWidthStateIdentity {
  cacheKey?: string;
  structureSignature: string;
  measurementSignature: string;
}

export interface DataGridColumnWidthStateSnapshot {
  widths: Array<number | undefined>;
  userSizedColumnIndexes: Set<number>;
  autoFittedColumnIndexes?: Set<number>;
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
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string" && key.length > 0) : [];
  } catch {
    return [];
  }
}

function saveStorageIndex(index: string[]) {
  safeLocalStorageSet(STORAGE_INDEX_KEY, JSON.stringify(index));
}

function getActualStorageKeys(): Set<string> {
  const keys = safeLocalStorageKeys();
  const actualKeys = new Set<string>();
  for (const key of keys) {
    if (key.startsWith(STORAGE_PREFIX)) {
      actualKeys.add(key.slice(STORAGE_PREFIX.length));
    }
  }
  return actualKeys;
}

function reconcileStorageIndex(activeKey?: string): string[] {
  const currentIndex = loadStorageIndex();
  const actualDataKeys = getActualStorageKeys();

  if (currentIndex.length === 0 && actualDataKeys.size === 0) {
    return activeKey ? [activeKey] : [];
  }

  const seen = new Set<string>();
  const validIndex: string[] = [];

  // 1. Keep indexed keys that actually have data in storage, preserving order (prunes orphan index entries)
  for (const key of currentIndex) {
    if (actualDataKeys.has(key) && !seen.has(key) && key !== activeKey) {
      seen.add(key);
      validIndex.push(key);
    }
  }

  // 2. Adopt unindexed stored keys (recovers orphan data entries from concurrent multi-window writes)
  for (const dataKey of actualDataKeys) {
    if (!seen.has(dataKey) && dataKey !== activeKey) {
      seen.add(dataKey);
      validIndex.unshift(dataKey);
    }
  }

  // 3. Place activeKey at the most-recent end
  if (activeKey) {
    validIndex.push(activeKey);
  }

  return validIndex;
}

function touchStorageKey(cacheKey: string) {
  const index = reconcileStorageIndex(cacheKey);
  while (index.length > DATA_GRID_COLUMN_WIDTH_STATE_LIMIT) {
    const oldest = index.shift();
    if (oldest) safeLocalStorageRemove(`${STORAGE_PREFIX}${oldest}`);
  }
  saveStorageIndex(index);
}

function removeStorageKey(cacheKey: string) {
  safeLocalStorageRemove(`${STORAGE_PREFIX}${cacheKey}`);
  const index = loadStorageIndex().filter((key) => key !== cacheKey);
  saveStorageIndex(index);
}

function loadPersistentDataGridColumnWidthState(cacheKey: string): DataGridColumnWidthState | undefined {
  const raw = safeLocalStorageGet(`${STORAGE_PREFIX}${cacheKey}`);
  if (!raw) {
    const index = loadStorageIndex();
    if (index.includes(cacheKey)) {
      saveStorageIndex(index.filter((key) => key !== cacheKey));
    }
    return undefined;
  }
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
    const autoFittedColumnIndexes = new Set<number>();
    if (Array.isArray(parsed.autoFittedColumnIndexes)) {
      for (const index of parsed.autoFittedColumnIndexes) {
        if (typeof index === "number") autoFittedColumnIndexes.add(index);
      }
    }
    touchStorageKey(cacheKey);
    return {
      structureSignature: parsed.structureSignature,
      measurementSignature: parsed.measurementSignature,
      widthsByColumnIndex,
      userSizedColumnIndexes,
      autoFittedColumnIndexes,
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
    ...(state.autoFittedColumnIndexes && state.autoFittedColumnIndexes.size > 0 ? { autoFittedColumnIndexes: Array.from(state.autoFittedColumnIndexes) } : {}),
  };
  safeLocalStorageSet(`${STORAGE_PREFIX}${cacheKey}`, JSON.stringify(payload));
  touchStorageKey(cacheKey);
}

function removePersistentDataGridColumnWidthState(cacheKey: string) {
  removeStorageKey(cacheKey);
}

function clearPersistentDataGridColumnWidthStates() {
  const allKeys = safeLocalStorageKeys();
  for (const key of allKeys) {
    if (key.startsWith(STORAGE_PREFIX)) {
      safeLocalStorageRemove(key);
    }
  }
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
  if (state.structureSignature !== identity.structureSignature) {
    columnWidthStates.delete(cacheKey);
    removePersistentDataGridColumnWidthState(cacheKey);
    return undefined;
  }
  if (state.measurementSignature !== identity.measurementSignature) {
    if (state.userSizedColumnIndexes.size === 0) {
      columnWidthStates.delete(cacheKey);
      removePersistentDataGridColumnWidthState(cacheKey);
      return undefined;
    }
    const userWidthsByColumnIndex = new Map<number, number>();
    for (const columnIndex of state.userSizedColumnIndexes) {
      const width = state.widthsByColumnIndex.get(columnIndex);
      if (width !== undefined && Number.isFinite(width)) {
        userWidthsByColumnIndex.set(columnIndex, width);
      }
    }
    if (userWidthsByColumnIndex.size === 0) {
      columnWidthStates.delete(cacheKey);
      removePersistentDataGridColumnWidthState(cacheKey);
      return undefined;
    }
    state.measurementSignature = identity.measurementSignature;
    state.widthsByColumnIndex = userWidthsByColumnIndex;
    state.autoFittedColumnIndexes?.clear();
    touchColumnWidthState(cacheKey, state);
    savePersistentDataGridColumnWidthState(cacheKey, state);
    return {
      widths: columnIndexes.map((columnIndex) => (state.userSizedColumnIndexes.has(columnIndex) ? state.widthsByColumnIndex.get(columnIndex) : undefined)),
      userSizedColumnIndexes: new Set(state.userSizedColumnIndexes),
      autoFittedColumnIndexes: new Set(),
    };
  }
  touchColumnWidthState(cacheKey, state);
  return {
    widths: columnIndexes.map((columnIndex) => state.widthsByColumnIndex.get(columnIndex)),
    userSizedColumnIndexes: new Set(state.userSizedColumnIndexes),
    autoFittedColumnIndexes: new Set(state.autoFittedColumnIndexes ?? []),
  };
}

export function saveDataGridColumnWidthState(identity: DataGridColumnWidthStateIdentity, columnIndexes: readonly number[], widths: readonly number[], userSizedColumnIndexes: ReadonlySet<number>, autoFittedColumnIndexes?: ReadonlySet<number>) {
  const cacheKey = identity.cacheKey?.trim();
  if (!cacheKey || columnIndexes.length !== widths.length) return;
  const existing = columnWidthStates.get(cacheKey) ?? loadPersistentDataGridColumnWidthState(cacheKey);
  const sameStructure = existing?.structureSignature === identity.structureSignature;
  const sameMeasurement = existing?.measurementSignature === identity.measurementSignature;
  const widthsByColumnIndex = new Map<number, number>();
  const nextUserSizedColumnIndexes = new Set<number>();
  const nextAutoFittedColumnIndexes = new Set<number>();

  if (sameStructure && existing) {
    for (const [columnIndex, width] of existing.widthsByColumnIndex) {
      if (sameMeasurement || existing.userSizedColumnIndexes.has(columnIndex)) {
        widthsByColumnIndex.set(columnIndex, width);
      }
    }
    for (const columnIndex of existing.userSizedColumnIndexes) {
      nextUserSizedColumnIndexes.add(columnIndex);
    }
    if (sameMeasurement && existing.autoFittedColumnIndexes) {
      for (const columnIndex of existing.autoFittedColumnIndexes) {
        nextAutoFittedColumnIndexes.add(columnIndex);
      }
    }
  }

  columnIndexes.forEach((columnIndex, visibleIndex) => {
    const width = widths[visibleIndex];
    if (Number.isFinite(width)) widthsByColumnIndex.set(columnIndex, width);
    if (userSizedColumnIndexes.has(columnIndex)) {
      nextUserSizedColumnIndexes.add(columnIndex);
      nextAutoFittedColumnIndexes.delete(columnIndex);
    } else {
      nextUserSizedColumnIndexes.delete(columnIndex);
    }
    if (autoFittedColumnIndexes?.has(columnIndex)) {
      nextAutoFittedColumnIndexes.add(columnIndex);
    } else if (autoFittedColumnIndexes !== undefined) {
      nextAutoFittedColumnIndexes.delete(columnIndex);
    }
  });
  const nextState: DataGridColumnWidthState = {
    structureSignature: identity.structureSignature,
    measurementSignature: identity.measurementSignature,
    widthsByColumnIndex,
    userSizedColumnIndexes: nextUserSizedColumnIndexes,
    autoFittedColumnIndexes: nextAutoFittedColumnIndexes,
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

export function reconcileDataGridColumnWidthStorageIndex(): string[] {
  const index = reconcileStorageIndex();
  while (index.length > DATA_GRID_COLUMN_WIDTH_STATE_LIMIT) {
    const oldest = index.shift();
    if (oldest) safeLocalStorageRemove(`${STORAGE_PREFIX}${oldest}`);
  }
  saveStorageIndex(index);
  return index;
}
