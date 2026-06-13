import type { QueryResult, QueryTab } from "@/types/database";
import { decode, encode } from "@msgpack/msgpack";
import { toRaw } from "vue";
import { isTauriRuntime } from "@/lib/tauriRuntime";

const DB_NAME = "dbx-tab-runtime-cache";
const DB_VERSION = 1;
const RESULT_STORE = "resultSnapshots";
const PAYLOAD_MAGIC = "DBX_TAB_RESULT_CACHE";
const PAYLOAD_VERSION = 1;
const PAYLOAD_CODEC = "msgpack-columnar";
type CellValue = QueryResult["rows"][number][number];

export interface TabResultSnapshot {
  result?: QueryResult;
  results?: QueryResult[];
  activeResultIndex?: number;
  resultRuns?: QueryTab["resultRuns"];
  activeResultRunId?: string;
  queryAnalysis?: QueryTab["queryAnalysis"];
  querySourceColumns?: QueryTab["querySourceColumns"];
  queryEditabilityReason?: QueryTab["queryEditabilityReason"];
  tableMeta?: QueryTab["tableMeta"];
  resultPageSql?: string;
  resultPageLimit?: number;
  resultPageOffset?: number;
  resultCountSql?: string;
  resultTotalRowCount?: number;
  cachedAt: number;
}

interface ColumnarQueryResult {
  columns: string[];
  column_types?: string[];
  columnValues: CellValue[][];
  rowCount: number;
  affected_rows: number;
  execution_time_ms: number;
  truncated?: boolean;
  has_more?: boolean;
}

type QueryResultRunSnapshot = NonNullable<QueryTab["resultRuns"]>[number];

interface ColumnarQueryResultRun extends Omit<QueryResultRunSnapshot, "result" | "results"> {
  result?: ColumnarQueryResult;
  results?: ColumnarQueryResult[];
}

interface TabResultSnapshotPayload extends Omit<TabResultSnapshot, "result" | "results" | "resultRuns"> {
  result?: ColumnarQueryResult;
  results?: ColumnarQueryResult[];
  resultRuns?: ColumnarQueryResultRun[];
}

interface TabResultCacheEnvelope {
  magic: typeof PAYLOAD_MAGIC;
  version: typeof PAYLOAD_VERSION;
  codec: typeof PAYLOAD_CODEC;
  cachedAt: number;
  rowCount: number;
  columnCount: number;
  payload: TabResultSnapshotPayload;
}

function indexedDb(): IDBFactory | undefined {
  return typeof globalThis.indexedDB === "undefined" ? undefined : globalThis.indexedDB;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

let dbPromise: Promise<IDBDatabase | null> | undefined;
const cacheKeyVersions = new Map<string, number>();

function bumpCacheKeyVersion(key: string): number {
  const version = (cacheKeyVersions.get(key) ?? 0) + 1;
  cacheKeyVersions.set(key, version);
  return version;
}

function isCurrentCacheKeyVersion(key: string, version: number): boolean {
  return cacheKeyVersions.get(key) === version;
}

function clearCacheKeyVersionIfCurrent(key: string, version: number) {
  if (isCurrentCacheKeyVersion(key, version)) cacheKeyVersions.delete(key);
}

function openCacheDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  const idb = indexedDb();
  if (!idb) return Promise.resolve(null);

  dbPromise = new Promise((resolve) => {
    const request = idb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RESULT_STORE)) db.createObjectStore(RESULT_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      console.warn("[DBX][tab-result-cache:open:error]", request.error);
      resolve(null);
    };
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function clonePlain<T>(value: T): T {
  const raw = toRaw(value);
  if (typeof structuredClone === "function") return structuredClone(raw);
  return JSON.parse(JSON.stringify(raw)) as T;
}

function stripSessionIds(result: QueryResult | undefined): QueryResult | undefined {
  if (!result) return undefined;
  return {
    columns: [...result.columns],
    column_types: result.column_types ? [...result.column_types] : undefined,
    rows: result.rows.map((row) => [...row]),
    affected_rows: result.affected_rows,
    execution_time_ms: result.execution_time_ms,
    truncated: result.truncated,
    session_id: undefined,
    has_more: result.has_more,
  };
}

function stripResultSessionIds(results: QueryResult[] | undefined): QueryResult[] | undefined {
  return results?.map((result) => stripSessionIds(result)!);
}

function stripResultRunSessionIds(resultRuns: QueryTab["resultRuns"]): QueryTab["resultRuns"] {
  return resultRuns?.map((run) => ({
    ...run,
    result: stripSessionIds(run.result),
    results: stripResultSessionIds(run.results),
    resultSessionId: undefined,
  }));
}

function toColumnarResult(result: QueryResult | undefined): ColumnarQueryResult | undefined {
  if (!result) return undefined;
  const columnValues = result.columns.map((_, colIndex) => result.rows.map((row) => row[colIndex] ?? null));
  return removeUndefinedFields({
    columns: [...result.columns],
    column_types: result.column_types ? [...result.column_types] : undefined,
    columnValues,
    rowCount: result.rows.length,
    affected_rows: result.affected_rows,
    execution_time_ms: result.execution_time_ms,
    truncated: result.truncated,
    has_more: result.has_more,
  });
}

function fromColumnarResult(result: ColumnarQueryResult | undefined): QueryResult | undefined {
  if (!result) return undefined;
  const rows = Array.from({ length: result.rowCount }, (_, rowIndex) => result.columnValues.map((values) => values[rowIndex] ?? null));
  return {
    columns: [...result.columns],
    column_types: result.column_types ? [...result.column_types] : undefined,
    rows,
    affected_rows: result.affected_rows,
    execution_time_ms: result.execution_time_ms,
    truncated: result.truncated,
    session_id: undefined,
    has_more: result.has_more,
  };
}

function snapshotToPayload(snapshot: TabResultSnapshot): TabResultSnapshotPayload {
  return removeUndefinedFields({
    ...snapshot,
    result: toColumnarResult(snapshot.result),
    results: snapshot.results?.map((result) => toColumnarResult(result)!),
    resultRuns: snapshot.resultRuns?.map((run) =>
      removeUndefinedFields({
        ...run,
        result: toColumnarResult(run.result),
        results: run.results?.map((result) => toColumnarResult(result)!),
      }),
    ),
  });
}

function payloadToSnapshot(payload: TabResultSnapshotPayload): TabResultSnapshot {
  return {
    ...payload,
    result: fromColumnarResult(payload.result),
    results: payload.results?.map((result) => fromColumnarResult(result)!),
    resultRuns: payload.resultRuns?.map((run) => ({
      ...run,
      result: fromColumnarResult(run.result),
      results: run.results?.map((result) => fromColumnarResult(result)!),
    })),
  };
}

function resultStats(snapshot: TabResultSnapshot): { rowCount: number; columnCount: number } {
  const activeRun = snapshot.resultRuns?.find((run) => run.id === snapshot.activeResultRunId) ?? snapshot.resultRuns?.[0];
  const result = snapshot.result ?? snapshot.results?.[snapshot.activeResultIndex ?? 0] ?? snapshot.results?.[0] ?? activeRun?.result ?? activeRun?.results?.[activeRun.activeResultIndex ?? 0] ?? activeRun?.results?.[0];
  return {
    rowCount: result?.rows.length ?? 0,
    columnCount: result?.columns.length ?? 0,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function canUseRemoteRuntimeCache(): boolean {
  return typeof btoa !== "undefined" && typeof atob !== "undefined" && (isTauriRuntime() || typeof fetch !== "undefined");
}

async function writeRemoteRuntimeCache(key: string, bytes: Uint8Array, stats: { rowCount: number; columnCount: number }): Promise<boolean> {
  if (!canUseRemoteRuntimeCache()) return false;
  try {
    if (isTauriRuntime()) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_tab_runtime_cache", {
        key,
        payloadBase64: bytesToBase64(bytes),
        rowCount: stats.rowCount,
        columnCount: stats.columnCount,
      });
      return true;
    }
    const response = await fetch("/api/tab-runtime-cache", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key,
        payloadBase64: bytesToBase64(bytes),
        rowCount: stats.rowCount,
        columnCount: stats.columnCount,
      }),
    });
    return response.ok;
  } catch (error) {
    console.warn("[DBX][tab-result-cache:remote-write:error]", { key, error });
    return false;
  }
}

async function readRemoteRuntimeCache(key: string): Promise<Uint8Array | undefined> {
  if (!canUseRemoteRuntimeCache()) return undefined;
  try {
    if (isTauriRuntime()) {
      const { invoke } = await import("@tauri-apps/api/core");
      const entry = await invoke<{ payloadBase64?: string } | null>("load_tab_runtime_cache", { key });
      return entry?.payloadBase64 ? base64ToBytes(entry.payloadBase64) : undefined;
    }
    const response = await fetch(`/api/tab-runtime-cache?key=${encodeURIComponent(key)}`);
    if (!response.ok) return undefined;
    const entry = (await response.json()) as { payloadBase64?: string } | null;
    return entry?.payloadBase64 ? base64ToBytes(entry.payloadBase64) : undefined;
  } catch (error) {
    console.warn("[DBX][tab-result-cache:remote-read:error]", { key, error });
    return undefined;
  }
}

async function deleteRemoteRuntimeCache(key: string): Promise<void> {
  if (!canUseRemoteRuntimeCache()) return;
  try {
    if (isTauriRuntime()) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("delete_tab_runtime_cache", { key });
      return;
    }
    await fetch(`/api/tab-runtime-cache?key=${encodeURIComponent(key)}`, { method: "DELETE" });
  } catch (error) {
    console.warn("[DBX][tab-result-cache:remote-delete:error]", { key, error });
  }
}

function scheduleRemoteRuntimeCacheWrite(key: string, bytes: Uint8Array, stats: { rowCount: number; columnCount: number }, version: number) {
  window.setTimeout(async () => {
    if (!isCurrentCacheKeyVersion(key, version)) return;
    await writeRemoteRuntimeCache(key, bytes, stats);
    clearCacheKeyVersionIfCurrent(key, version);
  }, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeUndefinedFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => removeUndefinedFields(item)) as T;
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => [key, removeUndefinedFields(entryValue)]),
  ) as T;
}

function isBinaryPayload(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || value instanceof ArrayBuffer;
}

export function encodeTabResultSnapshot(snapshot: TabResultSnapshot): Uint8Array {
  const stats = resultStats(snapshot);
  const envelope: TabResultCacheEnvelope = {
    magic: PAYLOAD_MAGIC,
    version: PAYLOAD_VERSION,
    codec: PAYLOAD_CODEC,
    cachedAt: snapshot.cachedAt,
    rowCount: stats.rowCount,
    columnCount: stats.columnCount,
    payload: snapshotToPayload(snapshot),
  };
  return encode(removeUndefinedFields(envelope));
}

export function decodeTabResultSnapshot(bytes: Uint8Array | ArrayBuffer): TabResultSnapshot | undefined {
  const decoded = decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  if (!isRecord(decoded)) return undefined;
  if (decoded.magic !== PAYLOAD_MAGIC || decoded.version !== PAYLOAD_VERSION || decoded.codec !== PAYLOAD_CODEC) {
    return undefined;
  }
  if (!isRecord(decoded.payload)) return undefined;
  return payloadToSnapshot(decoded.payload as unknown as TabResultSnapshotPayload);
}

export function tabResultCacheKey(tabId: string): string {
  return `tab:${tabId}:result`;
}

export function buildTabResultSnapshot(tab: QueryTab): TabResultSnapshot | undefined {
  if (!tab.result && !tab.results && !tab.resultRuns?.length) return undefined;
  return {
    result: stripSessionIds(tab.result),
    results: stripResultSessionIds(tab.results),
    activeResultIndex: tab.activeResultIndex,
    resultRuns: stripResultRunSessionIds(tab.resultRuns),
    activeResultRunId: tab.activeResultRunId,
    queryAnalysis: tab.queryAnalysis ? clonePlain(tab.queryAnalysis) : undefined,
    querySourceColumns: tab.querySourceColumns ? [...tab.querySourceColumns] : undefined,
    queryEditabilityReason: tab.queryEditabilityReason,
    tableMeta: tab.tableMeta ? clonePlain(tab.tableMeta) : undefined,
    resultPageSql: tab.resultPageSql,
    resultPageLimit: tab.resultPageLimit,
    resultPageOffset: tab.resultPageOffset,
    resultCountSql: tab.resultCountSql,
    resultTotalRowCount: tab.resultTotalRowCount,
    cachedAt: Date.now(),
  };
}

export async function writeTabResultSnapshot(key: string, snapshot: TabResultSnapshot | undefined): Promise<boolean> {
  if (!snapshot) return false;
  const version = bumpCacheKeyVersion(key);
  const encoded = encodeTabResultSnapshot(snapshot);
  const stats = resultStats(snapshot);
  let wroteLocal = false;
  try {
    const db = await openCacheDb();
    if (db) {
      const tx = db.transaction(RESULT_STORE, "readwrite");
      await requestToPromise(tx.objectStore(RESULT_STORE).put(encoded, key));
      wroteLocal = true;
    }
  } catch (error) {
    console.warn("[DBX][tab-result-cache:write:error]", { key, error });
  }
  if (wroteLocal) {
    if (typeof window === "undefined") {
      void writeRemoteRuntimeCache(key, encoded, stats).finally(() => clearCacheKeyVersionIfCurrent(key, version));
    } else {
      scheduleRemoteRuntimeCacheWrite(key, encoded, stats, version);
    }
    return true;
  }
  if (!isCurrentCacheKeyVersion(key, version)) return false;
  try {
    return await writeRemoteRuntimeCache(key, encoded, stats);
  } finally {
    clearCacheKeyVersionIfCurrent(key, version);
  }
}

export async function readTabResultSnapshot(key: string): Promise<TabResultSnapshot | undefined> {
  try {
    const db = await openCacheDb();
    if (db) {
      const value = await requestToPromise(db.transaction(RESULT_STORE, "readonly").objectStore(RESULT_STORE).get(key));
      if (isBinaryPayload(value)) return decodeTabResultSnapshot(value);
      if (value) return value as TabResultSnapshot;
    }
    const remoteBytes = await readRemoteRuntimeCache(key);
    const remoteSnapshot = remoteBytes ? decodeTabResultSnapshot(remoteBytes) : undefined;
    if (remoteBytes && remoteSnapshot && db) {
      void requestToPromise(db.transaction(RESULT_STORE, "readwrite").objectStore(RESULT_STORE).put(remoteBytes, key));
    }
    return remoteSnapshot;
  } catch (error) {
    console.warn("[DBX][tab-result-cache:read:error]", { key, error });
    const remoteBytes = await readRemoteRuntimeCache(key);
    return remoteBytes ? decodeTabResultSnapshot(remoteBytes) : undefined;
  }
}

export async function deleteTabResultSnapshot(key: string): Promise<void> {
  const version = bumpCacheKeyVersion(key);
  const clearVersionLater = () => {
    const cleanup = () => clearCacheKeyVersionIfCurrent(key, version);
    if (typeof window !== "undefined") window.setTimeout(cleanup, 5000);
    else setTimeout(cleanup, 5000);
  };
  try {
    const db = await openCacheDb();
    if (db) await requestToPromise(db.transaction(RESULT_STORE, "readwrite").objectStore(RESULT_STORE).delete(key));
    await deleteRemoteRuntimeCache(key);
    clearVersionLater();
  } catch (error) {
    console.warn("[DBX][tab-result-cache:delete:error]", { key, error });
    await deleteRemoteRuntimeCache(key);
    clearVersionLater();
  }
}
