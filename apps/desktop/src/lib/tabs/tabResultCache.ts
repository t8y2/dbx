import type { QueryResult, QueryTab } from "@/types/database";
import { decode, encode } from "@msgpack/msgpack";
import { toRaw } from "vue";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { apiUrl } from "@/lib/common/webPath";

const DB_NAME = "dbx-tab-runtime-cache";
const DB_VERSION = 2;
const RESULT_STORE = "resultSnapshots";
const RESULT_METADATA_STORE = "resultSnapshotMetadata";
const DEFAULT_PERSISTENT_CACHE_BYTES = 512 * 1024 * 1024;
const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PAYLOAD_MAGIC = "DBX_TAB_RESULT_CACHE";
const PAYLOAD_VERSION = 1;
const PAYLOAD_CODEC = "msgpack-columnar";
type CellValue = QueryResult["rows"][number][number];

export interface TabResultSnapshot {
  result?: QueryResult;
  results?: QueryResult[];
  activeResultIndex?: number;
  resultEditorFingerprint?: string;
  /**
   * Source ordering retained while a local grid sort is active. It must travel
   * with the snapshot so clearing the sort after a cache/archive restore can
   * still return to the original result order.
   */
  resultLocalSortOriginalRows?: QueryResult["rows"];
  resultLocalSortOriginalMongoDocuments?: QueryResult["mongo_documents"];
  resultLocalSortOriginalMongoCopyDocuments?: QueryResult["mongo_copy_documents"];
  resultRuns?: QueryTab["resultRuns"];
  activeResultRunId?: string;
  queryAnalysis?: QueryTab["queryAnalysis"];
  querySourceColumns?: QueryTab["querySourceColumns"];
  queryEditabilityReason?: QueryTab["queryEditabilityReason"];
  mongoEditTarget?: QueryTab["mongoEditTarget"];
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
  execution_error?: true;
  statement_index?: number;
  column_types?: string[];
  columnValues: CellValue[][];
  rowCount: number;
  mongo_documents?: unknown[];
  mongo_copy_documents?: unknown[];
  affected_rows: number;
  execution_time_ms: number;
  truncated?: boolean;
  has_more?: boolean;
  sourceLabel?: string;
  sourceStatement?: string;
  sourceFrom?: number;
  sourceTo?: number;
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

export type ResultCacheBackendName = "indexed-db" | "runtime";

export interface ResultCacheMetadata {
  key: string;
  rowCount: number;
  columnCount: number;
  byteSize: number;
  createdAt: number;
  lastAccessedAt: number;
  ownerId?: string;
}

export interface ResultCachePruneOptions {
  liveKeys: string[];
  maxBytes: number;
  orphanGraceMs: number;
  maxAgeMs?: number;
}

export interface ResultCachePruneResult {
  deletedEntries: number;
  deletedBytes: number;
  orphanDeletions: number;
  remainingEntries: number;
  remainingBytes: number;
}

export interface ResultCacheBackend {
  name: ResultCacheBackendName;
  available: () => boolean;
  read: (key: string) => Promise<Uint8Array | undefined>;
  write: (key: string, bytes: Uint8Array, stats: { rowCount: number; columnCount: number }, ownerId?: string) => Promise<boolean>;
  delete: (key: string) => Promise<void>;
  listMetadata: () => Promise<ResultCacheMetadata[]>;
  prune: (options: ResultCachePruneOptions) => Promise<ResultCachePruneResult>;
  deleteOwner: (ownerId: string) => Promise<void>;
}

const resultCacheDiagnostics = {
  cacheBytes: 0,
  evictions: 0,
  serializationCount: 0,
  serializationDurationMs: 0,
  serializedBytes: 0,
  orphanDeletions: 0,
  corruptSnapshots: 0,
};

export function getResultCacheDiagnostics() {
  return { ...resultCacheDiagnostics };
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
      if (!db.objectStoreNames.contains(RESULT_METADATA_STORE)) db.createObjectStore(RESULT_METADATA_STORE);
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

async function writeIndexedDbCache(key: string, bytes: Uint8Array, stats: { rowCount: number; columnCount: number }, ownerId?: string): Promise<boolean> {
  const db = await openCacheDb();
  if (!db) return false;
  const previous = (await requestToPromise(db.transaction(RESULT_METADATA_STORE, "readonly").objectStore(RESULT_METADATA_STORE).get(key))) as ResultCacheMetadata | undefined;
  const transaction = db.transaction([RESULT_STORE, RESULT_METADATA_STORE], "readwrite");
  const metadataStore = transaction.objectStore(RESULT_METADATA_STORE);
  const now = Date.now();
  await Promise.all([
    requestToPromise(transaction.objectStore(RESULT_STORE).put(bytes, key)),
    requestToPromise(
      metadataStore.put(
        {
          key,
          rowCount: stats.rowCount,
          columnCount: stats.columnCount,
          byteSize: bytes.byteLength,
          createdAt: previous?.createdAt ?? now,
          lastAccessedAt: now,
          ownerId,
        } satisfies ResultCacheMetadata,
        key,
      ),
    ),
  ]);
  return true;
}

async function readIndexedDbCache(key: string): Promise<Uint8Array | undefined> {
  const db = await openCacheDb();
  if (!db) return undefined;
  const value = await requestToPromise(db.transaction(RESULT_STORE, "readonly").objectStore(RESULT_STORE).get(key));
  if (isBinaryPayload(value)) {
    const previous = (await requestToPromise(db.transaction(RESULT_METADATA_STORE, "readonly").objectStore(RESULT_METADATA_STORE).get(key))) as ResultCacheMetadata | undefined;
    const store = db.transaction(RESULT_METADATA_STORE, "readwrite").objectStore(RESULT_METADATA_STORE);
    const now = Date.now();
    await requestToPromise(store.put(previous ? { ...previous, lastAccessedAt: now } : { key, rowCount: 0, columnCount: 0, byteSize: value.byteLength, createdAt: now, lastAccessedAt: now }, key));
  }
  return isBinaryPayload(value) ? new Uint8Array(value) : undefined;
}

async function deleteIndexedDbCache(key: string): Promise<void> {
  const db = await openCacheDb();
  if (!db) return;
  const transaction = db.transaction([RESULT_STORE, RESULT_METADATA_STORE], "readwrite");
  await Promise.all([requestToPromise(transaction.objectStore(RESULT_STORE).delete(key)), requestToPromise(transaction.objectStore(RESULT_METADATA_STORE).delete(key))]);
}

async function listIndexedDbCacheMetadata(): Promise<ResultCacheMetadata[]> {
  const db = await openCacheDb();
  if (!db) return [];
  const transaction = db.transaction([RESULT_STORE, RESULT_METADATA_STORE], "readonly");
  const metadataRequest = transaction.objectStore(RESULT_METADATA_STORE).getAll();
  const keysRequest = transaction.objectStore(RESULT_STORE).getAllKeys();
  const [metadata, keys] = await Promise.all([requestToPromise(metadataRequest) as Promise<ResultCacheMetadata[]>, requestToPromise(keysRequest)]);
  const byKey = new Map(metadata.map((entry) => [entry.key, entry]));
  const missingKeys = keys.map(String).filter((key) => !byKey.has(key));
  const migratedMetadata: ResultCacheMetadata[] = [];
  for (const key of missingKeys) {
    const value = await requestToPromise(db.transaction(RESULT_STORE, "readonly").objectStore(RESULT_STORE).get(key));
    const now = Date.now();
    const entry: ResultCacheMetadata = {
      key,
      rowCount: 0,
      columnCount: 0,
      byteSize: isBinaryPayload(value) ? value.byteLength : 0,
      createdAt: now,
      lastAccessedAt: now,
    };
    byKey.set(key, entry);
    migratedMetadata.push(entry);
  }
  if (migratedMetadata.length) {
    const migration = db.transaction(RESULT_METADATA_STORE, "readwrite").objectStore(RESULT_METADATA_STORE);
    await Promise.all(migratedMetadata.map((entry) => requestToPromise(migration.put(entry, entry.key))));
  }
  return [...byKey.values()];
}

export function selectResultCachePruneKeys(metadata: ResultCacheMetadata[], options: ResultCachePruneOptions, now = Date.now()): { keys: string[]; result: ResultCachePruneResult } {
  const live = new Set(options.liveKeys);
  const ordered = [...metadata].sort((left, right) => left.lastAccessedAt - right.lastAccessedAt || left.key.localeCompare(right.key));
  const deleted = new Set<string>();
  let remainingBytes = ordered.reduce((total, entry) => total + entry.byteSize, 0);
  let orphanDeletions = 0;
  for (const entry of ordered) {
    if (live.has(entry.key)) continue;
    const orphanExpired = now - entry.createdAt >= Math.max(0, options.orphanGraceMs);
    const ageExpired = options.maxAgeMs !== undefined && now - entry.lastAccessedAt >= Math.max(0, options.maxAgeMs);
    if (!orphanExpired && !ageExpired) continue;
    deleted.add(entry.key);
    remainingBytes -= entry.byteSize;
    if (orphanExpired) orphanDeletions += 1;
  }
  for (const entry of ordered) {
    if (remainingBytes <= Math.max(0, options.maxBytes)) break;
    if (live.has(entry.key) || deleted.has(entry.key)) continue;
    deleted.add(entry.key);
    remainingBytes -= entry.byteSize;
  }
  const deletedBytes = ordered.filter((entry) => deleted.has(entry.key)).reduce((total, entry) => total + entry.byteSize, 0);
  return {
    keys: [...deleted],
    result: {
      deletedEntries: deleted.size,
      deletedBytes,
      orphanDeletions,
      remainingEntries: ordered.length - deleted.size,
      remainingBytes,
    },
  };
}

async function pruneIndexedDbCache(options: ResultCachePruneOptions): Promise<ResultCachePruneResult> {
  const selection = selectResultCachePruneKeys(await listIndexedDbCacheMetadata(), options);
  await Promise.all(selection.keys.map(deleteIndexedDbCache));
  return selection.result;
}

async function deleteIndexedDbCacheOwner(ownerId: string): Promise<void> {
  const metadata = await listIndexedDbCacheMetadata();
  await Promise.all(metadata.filter((entry) => entry.ownerId === ownerId).map((entry) => deleteIndexedDbCache(entry.key)));
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
    execution_error: result.execution_error,
    statement_index: result.statement_index,
    column_types: result.column_types ? [...result.column_types] : undefined,
    rows: result.rows.map((row) => [...row]),
    mongo_documents: result.mongo_documents ? clonePlain(result.mongo_documents) : undefined,
    mongo_copy_documents: result.mongo_copy_documents ? clonePlain(result.mongo_copy_documents) : undefined,
    affected_rows: result.affected_rows,
    execution_time_ms: result.execution_time_ms,
    truncated: result.truncated,
    session_id: undefined,
    has_more: result.has_more,
    sourceLabel: result.sourceLabel,
    sourceStatement: result.sourceStatement,
    sourceFrom: result.sourceFrom,
    sourceTo: result.sourceTo,
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
    resultLocalSortOriginalRows: run.resultLocalSortOriginalRows?.map((row) => [...row]),
    resultLocalSortOriginalMongoDocuments: run.resultLocalSortOriginalMongoDocuments ? clonePlain(run.resultLocalSortOriginalMongoDocuments) : undefined,
    resultLocalSortOriginalMongoCopyDocuments: run.resultLocalSortOriginalMongoCopyDocuments ? clonePlain(run.resultLocalSortOriginalMongoCopyDocuments) : undefined,
    resultSessionId: undefined,
  }));
}

function toColumnarResult(result: QueryResult | undefined): ColumnarQueryResult | undefined {
  if (!result) return undefined;
  const columnValues = result.columns.map((_, colIndex) => result.rows.map((row) => row[colIndex] ?? null));
  return removeUndefinedFields({
    columns: [...result.columns],
    execution_error: result.execution_error,
    statement_index: result.statement_index,
    column_types: result.column_types ? [...result.column_types] : undefined,
    columnValues,
    rowCount: result.rows.length,
    mongo_documents: result.mongo_documents ? clonePlain(result.mongo_documents) : undefined,
    mongo_copy_documents: result.mongo_copy_documents ? clonePlain(result.mongo_copy_documents) : undefined,
    affected_rows: result.affected_rows,
    execution_time_ms: result.execution_time_ms,
    truncated: result.truncated,
    has_more: result.has_more,
    sourceLabel: result.sourceLabel,
    sourceStatement: result.sourceStatement,
    sourceFrom: result.sourceFrom,
    sourceTo: result.sourceTo,
  });
}

function fromColumnarResult(result: ColumnarQueryResult | undefined): QueryResult | undefined {
  if (!result) return undefined;
  const rows = Array.from({ length: result.rowCount }, (_, rowIndex) => result.columnValues.map((values) => values[rowIndex] ?? null));
  return {
    columns: [...result.columns],
    execution_error: result.execution_error,
    statement_index: result.statement_index,
    column_types: result.column_types ? [...result.column_types] : undefined,
    rows,
    mongo_documents: result.mongo_documents ? clonePlain(result.mongo_documents) : undefined,
    mongo_copy_documents: result.mongo_copy_documents ? clonePlain(result.mongo_copy_documents) : undefined,
    affected_rows: result.affected_rows,
    execution_time_ms: result.execution_time_ms,
    truncated: result.truncated,
    session_id: undefined,
    has_more: result.has_more,
    sourceLabel: result.sourceLabel,
    sourceStatement: result.sourceStatement,
    sourceFrom: result.sourceFrom,
    sourceTo: result.sourceTo,
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

async function writeRemoteRuntimeCache(key: string, bytes: Uint8Array, stats: { rowCount: number; columnCount: number }, ownerId?: string): Promise<boolean> {
  if (!canUseRemoteRuntimeCache()) return false;
  try {
    if (isTauriRuntime()) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_tab_runtime_cache", {
        key,
        payloadBase64: bytesToBase64(bytes),
        rowCount: stats.rowCount,
        columnCount: stats.columnCount,
        ownerId,
      });
      return true;
    }
    const response = await fetch(apiUrl("/api/tab-runtime-cache"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key,
        payloadBase64: bytesToBase64(bytes),
        rowCount: stats.rowCount,
        columnCount: stats.columnCount,
        ownerId,
      }),
    });
    return response.ok;
  } catch (error) {
    console.warn("[DBX][tab-result-cache:remote-write:error]", { key, error });
    return false;
  }
}

function normalizeRuntimeMetadata(entry: Record<string, unknown>): ResultCacheMetadata {
  return {
    key: String(entry.key ?? ""),
    rowCount: Number(entry.rowCount ?? 0),
    columnCount: Number(entry.columnCount ?? 0),
    byteSize: Number(entry.byteSize ?? 0),
    createdAt: Number(entry.createdAt ?? 0),
    lastAccessedAt: Number(entry.lastAccessedAt ?? 0),
    ownerId: typeof entry.ownerId === "string" ? entry.ownerId : undefined,
  };
}

async function listRemoteRuntimeCacheMetadata(): Promise<ResultCacheMetadata[]> {
  if (!canUseRemoteRuntimeCache()) return [];
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const entries = await invoke<Record<string, unknown>[]>("list_tab_runtime_cache_metadata");
    return entries.map(normalizeRuntimeMetadata);
  }
  const response = await fetch(apiUrl("/api/tab-runtime-cache/metadata"));
  if (!response.ok) return [];
  return ((await response.json()) as Record<string, unknown>[]).map(normalizeRuntimeMetadata);
}

async function pruneRemoteRuntimeCache(options: ResultCachePruneOptions): Promise<ResultCachePruneResult> {
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<ResultCachePruneResult>("prune_tab_runtime_cache", { request: options });
  }
  const response = await fetch(apiUrl("/api/tab-runtime-cache/prune"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!response.ok) throw new Error(`Runtime cache prune failed: ${response.status}`);
  return response.json() as Promise<ResultCachePruneResult>;
}

async function deleteRemoteRuntimeCacheOwner(ownerId: string): Promise<void> {
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("delete_tab_runtime_cache_owner", { ownerId });
    return;
  }
  await fetch(apiUrl(`/api/tab-runtime-cache/owner?owner_id=${encodeURIComponent(ownerId)}`), { method: "DELETE" });
}

async function readRemoteRuntimeCache(key: string): Promise<Uint8Array | undefined> {
  if (!canUseRemoteRuntimeCache()) return undefined;
  try {
    if (isTauriRuntime()) {
      const { invoke } = await import("@tauri-apps/api/core");
      const entry = await invoke<{ payloadBase64?: string } | null>("load_tab_runtime_cache", { key });
      return entry?.payloadBase64 ? base64ToBytes(entry.payloadBase64) : undefined;
    }
    const response = await fetch(apiUrl(`/api/tab-runtime-cache?key=${encodeURIComponent(key)}`));
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
    await fetch(apiUrl(`/api/tab-runtime-cache?key=${encodeURIComponent(key)}`), { method: "DELETE" });
  } catch (error) {
    console.warn("[DBX][tab-result-cache:remote-delete:error]", { key, error });
  }
}

const indexedDbBackend: ResultCacheBackend = {
  name: "indexed-db",
  available: () => indexedDb() !== undefined,
  read: readIndexedDbCache,
  write: writeIndexedDbCache,
  delete: deleteIndexedDbCache,
  listMetadata: listIndexedDbCacheMetadata,
  prune: pruneIndexedDbCache,
  deleteOwner: deleteIndexedDbCacheOwner,
};

const runtimeBackend: ResultCacheBackend = {
  name: "runtime",
  available: canUseRemoteRuntimeCache,
  read: readRemoteRuntimeCache,
  write: writeRemoteRuntimeCache,
  delete: deleteRemoteRuntimeCache,
  listMetadata: listRemoteRuntimeCacheMetadata,
  prune: pruneRemoteRuntimeCache,
  deleteOwner: deleteRemoteRuntimeCacheOwner,
};

export interface ResultCacheRuntimeConfig {
  primary: ResultCacheBackendName;
  fallbackEnabled: boolean;
}

export function resultCacheRuntimeConfig(tauriRuntime = isTauriRuntime(), environment = import.meta.env): ResultCacheRuntimeConfig {
  const configured = environment.VITE_DBX_RESULT_CACHE_BACKEND;
  const primary = tauriRuntime || configured === "http" || configured === "runtime" ? "runtime" : "indexed-db";
  return { primary, fallbackEnabled: environment.VITE_DBX_RESULT_CACHE_FALLBACK !== "false" };
}

export function resultCacheBackendOrder(tauriRuntime = isTauriRuntime(), config = resultCacheRuntimeConfig(tauriRuntime)): ResultCacheBackendName[] {
  return config.primary === "runtime" ? ["runtime", "indexed-db"] : ["indexed-db", "runtime"];
}

function availableResultCacheBackends(includeLegacyFallback = true): ResultCacheBackend[] {
  const byName: Record<ResultCacheBackendName, ResultCacheBackend> = {
    "indexed-db": indexedDbBackend,
    runtime: runtimeBackend,
  };
  const config = resultCacheRuntimeConfig();
  const order = resultCacheBackendOrder(isTauriRuntime(), config);
  const selected = includeLegacyFallback || config.fallbackEnabled ? order : order.slice(0, 1);
  return selected.map((name) => byName[name]).filter((backend) => backend.available());
}

export async function writeResultCacheBackends(backends: ResultCacheBackend[], key: string, bytes: Uint8Array, stats: { rowCount: number; columnCount: number }, isCurrent: () => boolean = () => true, ownerId?: string): Promise<boolean> {
  for (const backend of backends) {
    if (!isCurrent()) return false;
    try {
      if (await backend.write(key, bytes, stats, ownerId)) return true;
    } catch (error) {
      console.warn("[DBX][tab-result-cache:write:error]", { key, backend: backend.name, error });
    }
  }
  return false;
}

export async function readResultCacheBackends(backends: ResultCacheBackend[], key: string): Promise<{ bytes: Uint8Array; backend: ResultCacheBackend } | undefined> {
  for (const backend of backends) {
    try {
      const bytes = await backend.read(key);
      if (bytes) return { bytes, backend };
    } catch (error) {
      console.warn("[DBX][tab-result-cache:read:error]", { key, backend: backend.name, error });
    }
  }
  return undefined;
}

export async function promoteFallbackResultCacheRead(backends: ResultCacheBackend[], key: string, cached: { bytes: Uint8Array; backend: ResultCacheBackend }, stats: { rowCount: number; columnCount: number }, ownerId?: string): Promise<boolean> {
  const primary = backends[0];
  if (!primary || cached.backend === primary) return false;
  return primary.write(key, cached.bytes, stats, ownerId);
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
  let decoded: unknown;
  try {
    decoded = decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  } catch {
    resultCacheDiagnostics.corruptSnapshots += 1;
    return undefined;
  }
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
    resultEditorFingerprint: tab.resultEditorFingerprint,
    resultLocalSortOriginalRows: tab.resultLocalSortOriginalRows?.map((row) => [...row]),
    resultLocalSortOriginalMongoDocuments: tab.resultLocalSortOriginalMongoDocuments ? clonePlain(tab.resultLocalSortOriginalMongoDocuments) : undefined,
    resultLocalSortOriginalMongoCopyDocuments: tab.resultLocalSortOriginalMongoCopyDocuments ? clonePlain(tab.resultLocalSortOriginalMongoCopyDocuments) : undefined,
    resultRuns: stripResultRunSessionIds(tab.resultRuns),
    activeResultRunId: tab.activeResultRunId,
    queryAnalysis: tab.queryAnalysis ? clonePlain(tab.queryAnalysis) : undefined,
    querySourceColumns: tab.querySourceColumns ? [...tab.querySourceColumns] : undefined,
    queryEditabilityReason: tab.queryEditabilityReason,
    mongoEditTarget: tab.mongoEditTarget ? clonePlain(tab.mongoEditTarget) : undefined,
    tableMeta: tab.tableMeta ? clonePlain(tab.tableMeta) : undefined,
    resultPageSql: tab.resultPageSql,
    resultPageLimit: tab.resultPageLimit,
    resultPageOffset: tab.resultPageOffset,
    resultCountSql: tab.resultCountSql,
    resultTotalRowCount: tab.resultTotalRowCount,
    cachedAt: Date.now(),
  };
}

function afterActiveResultPaint(): Promise<void> {
  if (typeof window === "undefined" || typeof requestAnimationFrame === "undefined") return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(finish);
    // Background WebViews and test DOMs may throttle animation frames indefinitely.
    setTimeout(finish, 100);
  });
}

export async function writeTabResultSnapshot(key: string, snapshot: TabResultSnapshot | undefined, ownerId?: string): Promise<boolean> {
  if (!snapshot) return false;
  const version = bumpCacheKeyVersion(key);
  await afterActiveResultPaint();
  if (!isCurrentCacheKeyVersion(key, version)) return false;
  const startedAt = typeof performance === "undefined" ? Date.now() : performance.now();
  const encoded = encodeTabResultSnapshot(snapshot);
  const finishedAt = typeof performance === "undefined" ? Date.now() : performance.now();
  resultCacheDiagnostics.serializationCount += 1;
  resultCacheDiagnostics.serializationDurationMs += finishedAt - startedAt;
  resultCacheDiagnostics.serializedBytes += encoded.byteLength;
  const stats = resultStats(snapshot);
  try {
    return await writeResultCacheBackends(availableResultCacheBackends(false), key, encoded, stats, () => isCurrentCacheKeyVersion(key, version), ownerId);
  } finally {
    clearCacheKeyVersionIfCurrent(key, version);
  }
}

export async function readTabResultSnapshot(key: string): Promise<TabResultSnapshot | undefined> {
  const backends = availableResultCacheBackends(true);
  const cached = await readResultCacheBackends(backends, key);
  if (!cached) return undefined;
  const snapshot = decodeTabResultSnapshot(cached.bytes);
  if (!snapshot) return undefined;
  void promoteFallbackResultCacheRead(backends, key, cached, resultStats(snapshot));
  return snapshot;
}

export async function deleteTabResultSnapshot(key: string): Promise<void> {
  const version = bumpCacheKeyVersion(key);
  const clearVersionLater = () => {
    const cleanup = () => clearCacheKeyVersionIfCurrent(key, version);
    if (typeof window !== "undefined") window.setTimeout(cleanup, 5000);
    else setTimeout(cleanup, 5000);
  };
  try {
    await Promise.all(availableResultCacheBackends().map((backend) => backend.delete(key)));
    clearVersionLater();
  } catch (error) {
    console.warn("[DBX][tab-result-cache:delete:error]", { key, error });
    clearVersionLater();
  }
}

export async function pruneTabResultSnapshots(liveKeys: Iterable<string>, options: Partial<Omit<ResultCachePruneOptions, "liveKeys">> = {}): Promise<ResultCachePruneResult | undefined> {
  const primary = availableResultCacheBackends(false)[0];
  if (!primary) return undefined;
  const result = await primary.prune({
    liveKeys: [...new Set(liveKeys)],
    maxBytes: options.maxBytes ?? DEFAULT_PERSISTENT_CACHE_BYTES,
    orphanGraceMs: options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS,
    maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
  });
  resultCacheDiagnostics.cacheBytes = result.remainingBytes;
  resultCacheDiagnostics.evictions += result.deletedEntries;
  resultCacheDiagnostics.orphanDeletions += result.orphanDeletions;
  return result;
}

export async function deleteTabResultSnapshotsForOwner(ownerId: string): Promise<void> {
  await Promise.all(availableResultCacheBackends(true).map((backend) => backend.deleteOwner(ownerId)));
}
