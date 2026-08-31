import * as api from "@/lib/backend/api";
import { ActiveCacheReadTracker } from "./activeCacheReadTracker";
import type { MetadataCacheInvalidation } from "./metadataResultCache";
import type { ObjectDdlRequest } from "./objectDdlCache";
import { getMetadataRuntimeCache, invalidateMetadataRuntimeCachePrefix, recordMetadataCacheL2Hit, recordMetadataCacheRemoteMiss, setMetadataRuntimeCache } from "./metadataRuntimeCache";

const OBJECT_METADATA_CACHE_PREFIX = "object-meta:v1";
const MAX_PERSISTED_METADATA_CHARS = 5 * 1024 * 1024;
const MAX_PERSISTED_METADATA_AGE_MS = 24 * 60 * 60 * 1000;

interface ObjectMetadataCacheEnvelope<T> {
  version: 1;
  cachedAt: string;
  value: T;
}

interface InFlightLoad<T> {
  force: boolean;
  invalidated: boolean;
  promise: Promise<T>;
}

const inFlightLoads = new Map<string, InFlightLoad<unknown>>();
const activeCacheReads = new ActiveCacheReadTracker();
const pendingInvalidations = new Map<string, Promise<void>>();
const pendingWrites = new Map<string, Promise<void>>();

async function loadSchemaCacheSafe<T>(cacheKey: string): Promise<T | null> {
  try {
    return await api.loadSchemaCache<T>(cacheKey);
  } catch {
    return null;
  }
}

async function saveSchemaCacheSafe(cacheKey: string, payload: unknown): Promise<void> {
  try {
    await api.saveSchemaCache(cacheKey, payload);
  } catch {
    // Cache persistence is best effort and must not block metadata rendering.
  }
}

async function deleteSchemaCachePrefixSafe(prefix: string): Promise<void> {
  try {
    await api.deleteSchemaCachePrefix(prefix);
  } catch {
    // Cache invalidation is best effort when running with a reduced backend.
  }
}

export type ObjectMetadataFacet = "columns" | "indexes" | "foreign-keys" | "constraints" | "triggers" | "comment" | "owner";

function cacheSegment(value: string | undefined): string {
  return encodeURIComponent(value ?? "");
}

function facetKey(request: ObjectDdlRequest, facet: ObjectMetadataFacet): string {
  return `${[OBJECT_METADATA_CACHE_PREFIX, cacheSegment(request.connectionId), cacheSegment(request.database), cacheSegment(request.schema), cacheSegment(request.tableName), cacheSegment(request.catalog), cacheSegment(request.objectType ?? "TABLE"), facet].join(":")}:`;
}

function invalidationPrefix(match: MetadataCacheInvalidation): string {
  const parts = [OBJECT_METADATA_CACHE_PREFIX];
  if (!match.connectionId) return `${OBJECT_METADATA_CACHE_PREFIX}:`;
  parts.push(cacheSegment(match.connectionId));
  if (!match.database) return `${parts.join(":")}:`;
  parts.push(cacheSegment(match.database));
  if (!match.schema) return `${parts.join(":")}:`;
  parts.push(cacheSegment(match.schema));
  if (!match.tableName) return `${parts.join(":")}:`;
  parts.push(cacheSegment(match.tableName));
  return `${parts.join(":")}:`;
}

function decodeEnvelope<T>(payload: unknown): { hit: true; value: T } | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const envelope = payload as Partial<ObjectMetadataCacheEnvelope<T>>;
  const cachedAt = typeof envelope.cachedAt === "string" ? Date.parse(envelope.cachedAt) : Number.NaN;
  if (envelope.version !== 1 || !Number.isFinite(cachedAt) || Date.now() - cachedAt > MAX_PERSISTED_METADATA_AGE_MS || !("value" in envelope)) return undefined;
  return { hit: true, value: envelope.value as T };
}

async function waitForPendingInvalidations(cacheKey: string): Promise<void> {
  const pending = [...pendingInvalidations.entries()].filter(([prefix]) => cacheKey.startsWith(prefix)).map(([, promise]) => promise);
  if (pending.length) await Promise.all(pending);
}

function invalidateInFlightLoad(cacheKey: string): void {
  const entry = inFlightLoads.get(cacheKey);
  if (!entry) return;
  entry.invalidated = true;
  inFlightLoads.delete(cacheKey);
}

function persistSchemaCache(cacheKey: string, payload: unknown, isInvalidated: () => boolean): void {
  const previous = pendingWrites.get(cacheKey);
  const write = (async () => {
    if (previous) await previous;
    if (!isInvalidated()) await saveSchemaCacheSafe(cacheKey, payload);
  })().finally(() => {
    if (pendingWrites.get(cacheKey) === write) pendingWrites.delete(cacheKey);
  });
  pendingWrites.set(cacheKey, write);
}

async function waitForPendingWrites(prefix: string): Promise<void> {
  while (true) {
    const pending = [...pendingWrites.entries()].filter(([cacheKey]) => cacheKey.startsWith(prefix)).map(([, promise]) => promise);
    if (!pending.length) return;
    await Promise.all(pending);
  }
}

function invalidatePersistedPrefix(prefix: string): Promise<void> {
  const existing = pendingInvalidations.get(prefix);
  if (existing) return existing;
  const deletion = (async () => {
    await waitForPendingWrites(prefix);
    await deleteSchemaCachePrefixSafe(prefix);
  })().finally(() => {
    if (pendingInvalidations.get(prefix) === deletion) pendingInvalidations.delete(prefix);
  });
  pendingInvalidations.set(prefix, deletion);
  return deletion;
}

export async function loadObjectMetadataFacet<T>(request: ObjectDdlRequest, facet: ObjectMetadataFacet, loader: () => Promise<T>, options?: { force?: boolean }): Promise<{ value: T; cacheStatus: "memory" | "disk" | "remote" }> {
  const cacheKey = facetKey(request, facet);
  if (options?.force) {
    const existing = inFlightLoads.get(cacheKey);
    if (existing?.force) return { value: (await existing.promise) as T, cacheStatus: "remote" };
    invalidateInFlightLoad(cacheKey);
    activeCacheReads.invalidatePrefix(cacheKey);
    invalidateMetadataRuntimeCachePrefix(cacheKey);
    const priorInvalidations = waitForPendingInvalidations(cacheKey);
    const deletion = invalidatePersistedPrefix(cacheKey);
    await Promise.all([priorInvalidations, deletion]);
  } else {
    await waitForPendingInvalidations(cacheKey);
  }

  if (!options?.force) {
    const runtime = getMetadataRuntimeCache<T>(cacheKey);
    if (runtime) return { value: runtime.value, cacheStatus: "memory" };
    const readToken = activeCacheReads.begin(cacheKey);
    let cached: ReturnType<typeof decodeEnvelope<T>>;
    try {
      cached = decodeEnvelope<T>(await loadSchemaCacheSafe<unknown>(cacheKey));
    } finally {
      activeCacheReads.finish(readToken);
    }
    if (readToken.invalidated) {
      const value = await loadObjectMetadataFacet(request, facet, loader, { force: false });
      return { value: value.value, cacheStatus: "remote" };
    }
    if (cached?.hit) {
      recordMetadataCacheL2Hit(cacheKey, cached.value);
      setMetadataRuntimeCache(cacheKey, cached.value, request.connectionId);
      return { value: cached.value, cacheStatus: "disk" };
    }
  }

  const existing = inFlightLoads.get(cacheKey);
  if (existing && (!options?.force || existing.force)) return { value: (await existing.promise) as T, cacheStatus: "remote" };
  if (existing) invalidateInFlightLoad(cacheKey);

  const entry: InFlightLoad<T> = { force: options?.force === true, invalidated: false, promise: Promise.resolve(undefined as T) };
  recordMetadataCacheRemoteMiss(cacheKey);
  entry.promise = loader()
    .then((value) => {
      // Callers use undefined to signal that all metadata fallbacks failed.
      // Keep that result visible to the current request, but do not turn a
      // transient failure into a successful cache hit.
      if (value === undefined) return value;
      const serialized = JSON.stringify(value);
      const current = !entry.invalidated;
      if (current) setMetadataRuntimeCache(cacheKey, value, request.connectionId);
      if (current && serialized !== undefined && serialized.length <= MAX_PERSISTED_METADATA_CHARS) {
        const envelope: ObjectMetadataCacheEnvelope<T> = { version: 1, cachedAt: new Date().toISOString(), value };
        persistSchemaCache(cacheKey, envelope, () => entry.invalidated);
      }
      return value;
    })
    .finally(() => {
      if (inFlightLoads.get(cacheKey) === entry) inFlightLoads.delete(cacheKey);
    });
  inFlightLoads.set(cacheKey, entry as InFlightLoad<unknown>);
  return { value: await entry.promise, cacheStatus: "remote" };
}

export async function invalidateObjectMetadataCache(match: MetadataCacheInvalidation): Promise<void> {
  const prefix = invalidationPrefix(match);
  activeCacheReads.invalidatePrefix(prefix);
  for (const cacheKey of [...inFlightLoads.keys()]) if (cacheKey.startsWith(prefix)) invalidateInFlightLoad(cacheKey);
  invalidateMetadataRuntimeCachePrefix(prefix);

  return invalidatePersistedPrefix(prefix);
}

/** Invalidate active loads for a disconnected connection without deleting its persisted snapshot. */
export function cancelObjectMetadataLoadsForConnection(connectionId: string): void {
  const prefix = `${OBJECT_METADATA_CACHE_PREFIX}:${cacheSegment(connectionId)}:`;
  activeCacheReads.invalidatePrefix(prefix);
  for (const cacheKey of [...inFlightLoads.keys()]) if (cacheKey.startsWith(prefix)) invalidateInFlightLoad(cacheKey);
  invalidateMetadataRuntimeCachePrefix(prefix);
}

export function cancelObjectMetadataLoadsForDatabase(connectionId: string, database: string): void {
  const prefix = `${OBJECT_METADATA_CACHE_PREFIX}:${cacheSegment(connectionId)}:${cacheSegment(database)}:`;
  activeCacheReads.invalidatePrefix(prefix);
  for (const cacheKey of [...inFlightLoads.keys()]) if (cacheKey.startsWith(prefix)) invalidateInFlightLoad(cacheKey);
  invalidateMetadataRuntimeCachePrefix(prefix);
}

export function getObjectMetadataCacheDebugStateForTests(): { activeReads: number } {
  return { activeReads: activeCacheReads.activeCount };
}
