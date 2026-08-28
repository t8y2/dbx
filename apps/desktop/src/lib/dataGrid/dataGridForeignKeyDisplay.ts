import { displayCellValue, type CellValue } from "@/lib/dataGrid/cellValue";
import type { ColumnFormatterConfig, ForeignKeyDisplayFilterConfig } from "@/lib/dataGrid/columnFormatter";
import { isNumericColumnType } from "@/lib/dataGrid/dataGridColumnType";
import type { ForeignKeyAssociation } from "@/lib/dataGrid/dataGridForeignKeyNavigation";
import type { ColumnInfo, ForeignKeyInfo, QueryResult, ReferenceKeyInfo } from "@/types/database";

export type ForeignKeyDisplayConfig = Extract<ColumnFormatterConfig, { kind: "foreign-key-display" }>;

export const FOREIGN_KEY_DISPLAY_BATCH_SIZE = 500;
export const FOREIGN_KEY_DISPLAY_MAX_VALUES = 2000;
export const FOREIGN_KEY_DISPLAY_REQUEST_CONCURRENCY = 2;
export const FOREIGN_KEY_DISPLAY_REQUEST_CACHE_TTL_MS = 30_000;
export const FOREIGN_KEY_DISPLAY_REQUEST_CACHE_MAX_ENTRIES = 128;

export interface ForeignKeyDisplayRequestCoordinatorOptions {
  concurrency?: number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  now?: () => number;
}

interface ForeignKeyDisplayRequestEntry {
  generation: number;
  state: "queued" | "running" | "resolved" | "cancelled";
  expiresAt: number;
  promise: Promise<unknown | undefined>;
  resolve: (value: unknown | undefined) => void;
  reject: (reason: unknown) => void;
  task: () => Promise<unknown>;
}

export interface ForeignKeyDisplayRequestCoordinator {
  beginGeneration(): number;
  isCurrent(generation: number): boolean;
  request<T>(generation: number, key: string, task: () => Promise<T>): Promise<T | undefined>;
  dispose(): void;
}

export function createForeignKeyDisplayRequestCoordinator(options: ForeignKeyDisplayRequestCoordinatorOptions = {}): ForeignKeyDisplayRequestCoordinator {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? FOREIGN_KEY_DISPLAY_REQUEST_CONCURRENCY));
  const cacheTtlMs = Math.max(0, options.cacheTtlMs ?? FOREIGN_KEY_DISPLAY_REQUEST_CACHE_TTL_MS);
  const maxCacheEntries = Math.max(1, Math.floor(options.maxCacheEntries ?? FOREIGN_KEY_DISPLAY_REQUEST_CACHE_MAX_ENTRIES));
  const now = options.now ?? Date.now;
  const cache = new Map<string, ForeignKeyDisplayRequestEntry>();
  const queue: Array<{ key: string; entry: ForeignKeyDisplayRequestEntry }> = [];
  let generation = 0;
  let active = 0;
  let disposed = false;
  const isCurrent = (requestGeneration: number) => !disposed && requestGeneration === generation;

  const removeEntry = (key: string, entry: ForeignKeyDisplayRequestEntry) => {
    if (cache.get(key) === entry) cache.delete(key);
  };
  const cancelQueuedEntry = (key: string, entry: ForeignKeyDisplayRequestEntry) => {
    if (entry.state !== "queued") return;
    entry.state = "cancelled";
    removeEntry(key, entry);
    entry.resolve(undefined);
  };
  const pruneCache = () => {
    const timestamp = now();
    for (const [key, entry] of cache) {
      if (entry.state === "resolved" && entry.expiresAt <= timestamp) cache.delete(key);
    }
    if (cache.size <= maxCacheEntries) return;
    for (const [key, entry] of cache) {
      if (cache.size <= maxCacheEntries) break;
      if (entry.state === "resolved") cache.delete(key);
    }
  };
  const drain = () => {
    while (!disposed && active < concurrency && queue.length) {
      const queued = queue.shift()!;
      const { key, entry } = queued;
      if (entry.state !== "queued") continue;
      if (entry.generation !== generation) {
        cancelQueuedEntry(key, entry);
        continue;
      }
      entry.state = "running";
      active += 1;
      void entry
        .task()
        .then((value) => {
          entry.state = "resolved";
          entry.expiresAt = now() + cacheTtlMs;
          entry.resolve(value);
          pruneCache();
        })
        .catch((error) => {
          removeEntry(key, entry);
          entry.reject(error);
        })
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };

  return {
    beginGeneration() {
      generation += 1;
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const { key, entry } = queue[index];
        if (entry.generation === generation) continue;
        queue.splice(index, 1);
        cancelQueuedEntry(key, entry);
      }
      drain();
      return generation;
    },
    isCurrent,
    request<T>(requestGeneration: number, key: string, task: () => Promise<T>): Promise<T | undefined> {
      if (disposed || requestGeneration !== generation) return Promise.resolve(undefined);
      pruneCache();
      const cached = cache.get(key);
      if (cached) {
        cache.delete(key);
        cache.set(key, cached);
        return cached.promise.then((value) => (isCurrent(requestGeneration) ? (value as T | undefined) : undefined));
      }
      let resolve!: (value: unknown | undefined) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<unknown | undefined>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      const entry: ForeignKeyDisplayRequestEntry = {
        generation: requestGeneration,
        state: "queued",
        expiresAt: Number.POSITIVE_INFINITY,
        promise,
        resolve,
        reject,
        task,
      };
      cache.set(key, entry);
      queue.push({ key, entry });
      drain();
      return promise.then((value) => (isCurrent(requestGeneration) ? (value as T | undefined) : undefined));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      for (const { key, entry } of queue) cancelQueuedEntry(key, entry);
      queue.length = 0;
      cache.clear();
    },
  };
}

export function singleColumnForeignKey(association: ForeignKeyAssociation | null | undefined): ForeignKeyInfo | undefined {
  return association?.columnPairs.length === 1 ? association.foreignKey : undefined;
}

export function foreignKeyDisplayConfigMatches(config: ForeignKeyDisplayConfig, foreignKey: ForeignKeyInfo, currentSchema?: string): boolean {
  const expectedSchema = config.refSchema || currentSchema || "";
  const actualSchema = foreignKey.ref_schema || currentSchema || "";
  return config.refTable.toLowerCase() === foreignKey.ref_table.toLowerCase() && config.refColumn.toLowerCase() === foreignKey.ref_column.toLowerCase() && expectedSchema.toLowerCase() === actualSchema.toLowerCase();
}

export function foreignKeyDisplayConfigIsUsable(config: ForeignKeyDisplayConfig, foreignKey: ForeignKeyInfo | undefined, currentSchema?: string): boolean {
  if (config.referenceMode === "manual") return true;
  return !!foreignKey && foreignKeyDisplayConfigMatches(config, foreignKey, currentSchema);
}

export type ManualReferenceMetadataStatus = "loading" | "available" | "unavailable";
export type ManualReferenceColumnValidation = "pending" | "valid" | "invalid" | "unavailable";

export function manualReferenceKeySupportsColumn(referenceKeys: readonly ReferenceKeyInfo[], columnName: string, filter?: ForeignKeyDisplayFilterConfig): boolean {
  if (!columnName) return false;
  return referenceKeys.some((key) => {
    if (!key.columns.includes(columnName)) return false;
    if (key.columns.length === 1) return true;
    if (key.columns.length !== 2 || filter?.mode !== "equals" || !filter.value?.trim()) return false;
    const otherColumn = key.columns.find((column) => column !== columnName);
    return !!otherColumn && filter.column === otherColumn;
  });
}

export function manualReferenceKeyColumns(columns: readonly ColumnInfo[], referenceKeys: readonly ReferenceKeyInfo[], filter?: ForeignKeyDisplayFilterConfig): ColumnInfo[] {
  return columns.filter((column) => manualReferenceKeySupportsColumn(referenceKeys, column.name, filter));
}

export function manualReferenceKeyColumnIsUnique(columns: readonly ColumnInfo[], referenceKeys: readonly ReferenceKeyInfo[], columnName: string, filter?: ForeignKeyDisplayFilterConfig): boolean {
  return !!columns.some((column) => column.name === columnName) && manualReferenceKeySupportsColumn(referenceKeys, columnName, filter);
}

export function manualReferenceColumnValidation(columns: readonly ColumnInfo[], referenceKeys: readonly ReferenceKeyInfo[], columnName: string, metadataStatus: ManualReferenceMetadataStatus, filter?: ForeignKeyDisplayFilterConfig): ManualReferenceColumnValidation {
  if (metadataStatus === "loading") return "pending";
  if (metadataStatus === "unavailable") return "unavailable";
  return manualReferenceKeyColumnIsUnique(columns, referenceKeys, columnName, filter) ? "valid" : "invalid";
}

export function reconcileManualReferenceColumn(currentColumn: string, referenceColumns: readonly ColumnInfo[], metadataStatus: ManualReferenceMetadataStatus): string {
  if (currentColumn || metadataStatus !== "available") return currentColumn;
  return referenceColumns[0]?.name ?? "";
}

function canonicalNumericReferenceValue(value: string | number): string | undefined {
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : value.trim();
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return undefined;
  const integerDigits = match[2] ?? "";
  const fractionalDigits = match[3] ?? match[4] ?? "";
  const explicitExponent = Number(match[5] ?? 0);
  if (!Number.isSafeInteger(explicitExponent)) return undefined;
  let digits = `${integerDigits}${fractionalDigits}`;
  const firstNonZero = digits.search(/[1-9]/);
  if (firstNonZero < 0) return "0";
  let decimalPosition = integerDigits.length + explicitExponent - firstNonZero;
  digits = digits.slice(firstNonZero).replace(/0+$/, "");
  decimalPosition -= digits.length;
  return `${match[1] === "-" ? "-" : ""}${digits}e${decimalPosition}`;
}

export function foreignKeyDisplayValueKey(value: CellValue | undefined, keyDataType?: string): string | undefined {
  if (value === null || value === undefined || typeof value === "object") return undefined;
  if (isNumericColumnType(keyDataType) && (typeof value === "number" || typeof value === "string")) {
    const numericValue = canonicalNumericReferenceValue(value);
    if (numericValue !== undefined) return `numeric\u0000${numericValue}`;
  }
  return `${typeof value}\u0000${String(value)}`;
}

export function foreignKeyDisplayLookupRequestKey(options: { connectionId: string; database?: string; catalog?: string; schema?: string; table: string; refColumn: string; displayColumn: string; keyDataType?: string; filter?: ForeignKeyDisplayFilterConfig; values: readonly CellValue[] }): string {
  const valueKeys = options.values.map((value) => foreignKeyDisplayValueKey(value, options.keyDataType) ?? "").sort();
  return JSON.stringify(["lookup", options.connectionId, options.database ?? "", options.catalog ?? "", options.schema ?? "", options.table, options.refColumn, options.displayColumn, options.keyDataType ?? "", options.filter ?? null, valueKeys]);
}

export function collectForeignKeyDisplayValues(rows: QueryResult["rows"], columnIndex: number, keyDataType?: string, maxValues = FOREIGN_KEY_DISPLAY_MAX_VALUES): CellValue[] {
  const values: CellValue[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const value = row[columnIndex] as CellValue | undefined;
    const key = foreignKeyDisplayValueKey(value, keyDataType);
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

export function foreignKeyDisplayMapFromResult(result: QueryResult, keyColumn = result.columns[0], displayColumn = result.columns[1], keyDataType?: string): Map<string, string> {
  const map = new Map<string, string>();
  const keyIndex = result.columns.findIndex((column) => column === keyColumn);
  const displayIndex = result.columns.findIndex((column) => column === displayColumn);
  if (keyIndex < 0 || displayIndex < 0) return map;
  for (const row of result.rows) {
    const key = foreignKeyDisplayValueKey(row[keyIndex] as CellValue | undefined, keyDataType);
    const labelValue = row[displayIndex] as CellValue | undefined;
    if (!key || labelValue === null || labelValue === undefined || map.has(key)) continue;
    map.set(key, displayCellValue(labelValue));
  }
  return map;
}

export function formatForeignKeyDisplayValue(value: CellValue, labels: ReadonlyMap<string, string> | undefined, keyDataType?: string): string {
  const raw = displayCellValue(value);
  const key = foreignKeyDisplayValueKey(value, keyDataType);
  const label = key ? labels?.get(key) : undefined;
  if (label === undefined || label === raw || !label.trim()) return raw;
  return `${raw} (${label})`;
}
