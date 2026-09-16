import { appendDebugLog } from "@/lib/backend/debugLog";

export const METADATA_CACHE_DEFAULT_MEMORY_MB = 64;
export const METADATA_CACHE_MIN_MEMORY_MB = 16;
export const METADATA_CACHE_RECOMMENDED_MAX_MEMORY_MB = 256;
export const METADATA_CACHE_HARD_MAX_MEMORY_MB = 512;
export const METADATA_CACHE_MAX_ENTRY_BYTES = 1024 * 1024;

const METADATA_CACHE_CONNECTION_SHARE = 0.25;
const METADATA_CACHE_KEY_PREFIX = "dbx-metadata-cache:";

interface RuntimeCacheEntry<T = unknown> {
  key: string;
  connectionId: string;
  value: T;
  sizeBytes: number;
  touchedAt: number;
}

interface MetadataCacheLogContext {
  connectionId: string;
  database: string;
  facet: string;
}

export interface MetadataRuntimeCacheHit<T> {
  value: T;
  sizeBytes: number;
}

export interface MetadataRuntimeCacheDiagnostics {
  entries: number;
  bytes: number;
  maxMemoryBytes: number;
  maxEntryBytes: number;
  configuredMemoryMb: number;
  l1Hits: number;
  l1Misses: number;
  l2Hits: number;
  remoteMisses: number;
  evictions: number;
  connectionClears: number;
}

const entries = new Map<string, RuntimeCacheEntry>();
let configuredMemoryMb = METADATA_CACHE_DEFAULT_MEMORY_MB;
let totalBytes = 0;
let l1Hits = 0;
let l1Misses = 0;
let l2Hits = 0;
let remoteMisses = 0;
let evictions = 0;
let connectionClears = 0;

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function memoryBudgetBytes(): number {
  return configuredMemoryMb * 1024 * 1024;
}

function connectionBudgetBytes(): number {
  return Math.floor(memoryBudgetBytes() * METADATA_CACHE_CONNECTION_SHARE);
}

function keyConnectionId(key: string, connectionId?: string): string {
  if (connectionId) return connectionId;
  const marker = `${METADATA_CACHE_KEY_PREFIX}`;
  if (!key.startsWith(marker)) return "";
  return key.slice(marker.length).split(":", 1)[0] ?? "";
}

function estimateValueBytes(value: unknown): number {
  let serialized = "";
  try {
    serialized = JSON.stringify(value) ?? "null";
  } catch {
    serialized = String(value);
  }
  // JSON byte length is a lower bound for V8 heap usage. Account for UTF-16
  // strings and object/array/Map entry overhead with a conservative multiplier.
  const utf8Bytes = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(serialized).byteLength : serialized.length;
  return Math.max(256, utf8Bytes * 2 + 512);
}

function decodeCacheSegment(value: string | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cacheLogContext(key: string, fallbackConnectionId = ""): MetadataCacheLogContext {
  const parts = key.split(":");
  if ((parts[0] === "object-ddl" || parts[0] === "object-meta") && parts[1] === "v1") {
    return {
      connectionId: decodeCacheSegment(parts[2]) || fallbackConnectionId,
      database: decodeCacheSegment(parts[3]),
      facet: parts[0] === "object-ddl" ? "ddl" : decodeCacheSegment(parts[8]),
    };
  }
  return { connectionId: fallbackConnectionId, database: "", facet: "" };
}

function logCacheMetric(metric: string, key: string, details: Record<string, unknown> = {}, fallbackConnectionId = ""): void {
  appendDebugLog("debug", "[DBX][metadata-cache]", {
    metric,
    ...cacheLogContext(key, fallbackConnectionId),
    ...details,
    cacheBytes: totalBytes,
    cacheEntries: entries.size,
  });
}

function removeEntry(key: string, evictionReason?: string): boolean {
  const entry = entries.get(key);
  if (!entry) return false;
  entries.delete(key);
  totalBytes = Math.max(0, totalBytes - entry.sizeBytes);
  if (evictionReason) {
    evictions++;
    logCacheMetric("metadata_cache_eviction", key, { entrySizeBytes: entry.sizeBytes, evictionReason }, entry.connectionId);
  }
  return true;
}

function connectionBytes(connectionId: string): number {
  let bytes = 0;
  for (const entry of entries.values()) {
    if (entry.connectionId === connectionId) bytes += entry.sizeBytes;
  }
  return bytes;
}

function evictOldest(predicate: (entry: RuntimeCacheEntry) => boolean, reason: string): boolean {
  let oldest: RuntimeCacheEntry | undefined;
  for (const entry of entries.values()) {
    if (!predicate(entry)) continue;
    if (!oldest || entry.touchedAt < oldest.touchedAt) oldest = entry;
  }
  return oldest ? removeEntry(oldest.key, reason) : false;
}

function evictForInsert(connectionId: string, sizeBytes: number): boolean {
  const budget = memoryBudgetBytes();
  const perConnectionBudget = connectionBudgetBytes();
  while (connectionBytes(connectionId) + sizeBytes > perConnectionBudget) {
    if (!evictOldest((entry) => entry.connectionId === connectionId, "connection-budget")) return false;
  }
  while (totalBytes + sizeBytes > budget) {
    if (!evictOldest(() => true, "total-budget")) return false;
  }
  return true;
}

export function normalizeMetadataCacheMemoryMb(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return METADATA_CACHE_DEFAULT_MEMORY_MB;
  const rounded = Math.round(value);
  if (rounded > METADATA_CACHE_HARD_MAX_MEMORY_MB) return METADATA_CACHE_DEFAULT_MEMORY_MB;
  return Math.max(METADATA_CACHE_MIN_MEMORY_MB, rounded);
}

export function configureMetadataRuntimeCache(memoryMb: unknown): number {
  if (typeof memoryMb === "number" && Number.isFinite(memoryMb)) {
    const rounded = Math.round(memoryMb);
    if (rounded > METADATA_CACHE_HARD_MAX_MEMORY_MB) {
      console.warn(`[metadata-cache] memory limit ${rounded} MB exceeds the hard limit; falling back to ${METADATA_CACHE_DEFAULT_MEMORY_MB} MB`);
    } else if (rounded > METADATA_CACHE_RECOMMENDED_MAX_MEMORY_MB) {
      console.warn(`[metadata-cache] memory limit ${rounded} MB exceeds the recommended ${METADATA_CACHE_RECOMMENDED_MAX_MEMORY_MB} MB`);
    }
  }
  configuredMemoryMb = normalizeMetadataCacheMemoryMb(memoryMb);
  const connectionIds = new Set([...entries.values()].map((entry) => entry.connectionId));
  for (const connectionId of connectionIds) {
    while (connectionBytes(connectionId) > connectionBudgetBytes()) {
      if (!evictOldest((entry) => entry.connectionId === connectionId, "connection-budget-reconfigured")) break;
    }
  }
  while (totalBytes > memoryBudgetBytes()) {
    if (!evictOldest(() => true, "total-budget-reconfigured")) break;
  }
  return configuredMemoryMb;
}

export function getConfiguredMetadataCacheMemoryMb(): number {
  return configuredMemoryMb;
}

export function getMetadataRuntimeCache<T>(key: string): MetadataRuntimeCacheHit<T> | undefined {
  const entry = entries.get(key) as RuntimeCacheEntry<T> | undefined;
  if (!entry) {
    l1Misses++;
    return undefined;
  }
  entries.delete(key);
  entry.touchedAt = now();
  entries.set(key, entry);
  l1Hits++;
  logCacheMetric("metadata_cache_l1_hit", key, { entrySizeBytes: entry.sizeBytes }, entry.connectionId);
  return { value: entry.value, sizeBytes: entry.sizeBytes };
}

export function setMetadataRuntimeCache<T>(key: string, value: T, connectionId?: string): boolean {
  const sizeBytes = estimateValueBytes(value);
  if (sizeBytes > METADATA_CACHE_MAX_ENTRY_BYTES) {
    logCacheMetric("metadata_cache_l1_skip", key, { entrySizeBytes: sizeBytes, evictionReason: "entry-too-large" }, connectionId);
    return false;
  }
  removeEntry(key);
  const owner = keyConnectionId(key, connectionId);
  if (!evictForInsert(owner, sizeBytes)) return false;
  entries.set(key, { key, connectionId: owner, value, sizeBytes, touchedAt: now() });
  totalBytes += sizeBytes;
  logCacheMetric("metadata_cache_store", key, { entrySizeBytes: sizeBytes }, owner);
  return true;
}

export function invalidateMetadataRuntimeCachePrefix(prefix: string): number {
  let removed = 0;
  for (const key of [...entries.keys()]) {
    if (key === prefix || key.startsWith(prefix)) removed += removeEntry(key) ? 1 : 0;
  }
  return removed;
}

export function clearMetadataRuntimeCacheForConnection(connectionId: string): number {
  let removed = 0;
  for (const [key, entry] of [...entries.entries()]) {
    if (entry.connectionId === connectionId) removed += removeEntry(key) ? 1 : 0;
  }
  connectionClears++;
  logCacheMetric("metadata_cache_connection_clear", "", { connectionId, removedEntries: removed }, connectionId);
  return removed;
}

export function clearMetadataRuntimeCacheForDatabase(connectionId: string, database: string): number {
  let removed = 0;
  for (const [key, entry] of [...entries.entries()]) {
    const context = cacheLogContext(key, entry.connectionId);
    if (entry.connectionId === connectionId && context.database === database) removed += removeEntry(key) ? 1 : 0;
  }
  logCacheMetric("metadata_cache_database_clear", "", { connectionId, database, removedEntries: removed }, connectionId);
  return removed;
}

export function clearMetadataRuntimeCache(): void {
  entries.clear();
  totalBytes = 0;
  l1Hits = 0;
  l1Misses = 0;
  l2Hits = 0;
  remoteMisses = 0;
  evictions = 0;
  connectionClears = 0;
}

export function recordMetadataCacheL2Hit(key: string, value: unknown): void {
  l2Hits++;
  logCacheMetric("metadata_cache_l2_hit", key, { entrySizeBytes: estimateValueBytes(value) });
}

export function recordMetadataCacheRemoteMiss(key: string): void {
  remoteMisses++;
  logCacheMetric("metadata_cache_remote_miss", key);
}

export function getMetadataRuntimeCacheDiagnostics(): MetadataRuntimeCacheDiagnostics {
  return {
    entries: entries.size,
    bytes: totalBytes,
    maxMemoryBytes: memoryBudgetBytes(),
    maxEntryBytes: METADATA_CACHE_MAX_ENTRY_BYTES,
    configuredMemoryMb,
    l1Hits,
    l1Misses,
    l2Hits,
    remoteMisses,
    evictions,
    connectionClears,
  };
}
