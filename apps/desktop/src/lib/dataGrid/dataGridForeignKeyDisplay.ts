import { displayCellValue, type CellValue } from "@/lib/dataGrid/cellValue";
import type { ColumnFormatterConfig } from "@/lib/dataGrid/columnFormatter";
import type { ForeignKeyAssociation } from "@/lib/dataGrid/dataGridForeignKeyNavigation";
import type { ForeignKeyInfo, QueryResult } from "@/types/database";

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

export function foreignKeyDisplayValueKey(value: CellValue | undefined): string | undefined {
  if (value === null || value === undefined || typeof value === "object") return undefined;
  return `${typeof value}\u0000${String(value)}`;
}

export function foreignKeyDisplayLookupRequestKey(options: { connectionId: string; database?: string; catalog?: string; schema?: string; table: string; refColumn: string; displayColumn: string; values: readonly CellValue[] }): string {
  const valueKeys = options.values.map((value) => foreignKeyDisplayValueKey(value) ?? "").sort();
  return JSON.stringify(["lookup", options.connectionId, options.database ?? "", options.catalog ?? "", options.schema ?? "", options.table, options.refColumn, options.displayColumn, valueKeys]);
}

export function collectForeignKeyDisplayValues(rows: QueryResult["rows"], columnIndex: number, maxValues = FOREIGN_KEY_DISPLAY_MAX_VALUES): CellValue[] {
  const values: CellValue[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const value = row[columnIndex] as CellValue | undefined;
    const key = foreignKeyDisplayValueKey(value);
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

export function foreignKeyDisplayMapFromResult(result: QueryResult, keyColumn = result.columns[0], displayColumn = result.columns[1]): Map<string, string> {
  const map = new Map<string, string>();
  const keyIndex = result.columns.findIndex((column) => column.toLowerCase() === keyColumn?.toLowerCase());
  const displayIndex = result.columns.findIndex((column) => column.toLowerCase() === displayColumn?.toLowerCase());
  if (keyIndex < 0 || displayIndex < 0) return map;
  for (const row of result.rows) {
    const key = foreignKeyDisplayValueKey(row[keyIndex] as CellValue | undefined);
    const labelValue = row[displayIndex] as CellValue | undefined;
    if (!key || labelValue === null || labelValue === undefined || map.has(key)) continue;
    map.set(key, displayCellValue(labelValue));
  }
  return map;
}

export function formatForeignKeyDisplayValue(value: CellValue, labels: ReadonlyMap<string, string> | undefined): string {
  const raw = displayCellValue(value);
  const key = foreignKeyDisplayValueKey(value);
  const label = key ? labels?.get(key) : undefined;
  if (label === undefined || label === raw || !label.trim()) return raw;
  return `${raw} (${label})`;
}
