import * as api from "@/lib/backend/api";
import { ActiveCacheReadTracker } from "./activeCacheReadTracker";
import { metadataLoadBudgetMs, waitForMetadata } from "./metadataLoadBudget";
import type { MetadataCacheInvalidation } from "./metadataResultCache";
import type { ObjectDdlRequest } from "./objectDdlCache";
import { toObjectCacheInvalidationError, type ObjectCacheInvalidationOptions } from "./objectCacheInvalidationError";
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
const activeLoads = new ActiveCacheReadTracker();
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

export type ObjectMetadataFacet = "columns" | "indexes" | "foreign-keys" | "constraints" | "triggers" | "partitions" | "comment" | "owner";
export type ObjectMetadataRequest = ObjectDdlRequest & { oracleTriggerContract?: 1 };

function cacheSegment(value: string | undefined): string {
  return encodeURIComponent(value ?? "");
}

function facetKey(request: ObjectMetadataRequest, facet: ObjectMetadataFacet): string {
  const contract = facet === "triggers" && request.oracleTriggerContract === 1 ? ":oracle-trigger-exact-v1" : "";
  return `${[OBJECT_METADATA_CACHE_PREFIX, cacheSegment(request.connectionId), cacheSegment(request.database), cacheSegment(request.schema), cacheSegment(request.tableName), cacheSegment(request.catalog), cacheSegment(request.objectType ?? "TABLE"), ...(request.exactIdentity ? ["exact-v1"] : []), facet].join(":")}${contract}:`;
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
  // Readers only wait for pending deletions to settle; the failure itself is
  // reported by the caller that started the invalidation.
  const pending = [...pendingInvalidations.entries()].filter(([prefix]) => cacheKey.startsWith(prefix)).map(([, promise]) => promise.catch(() => undefined));
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
    // Deletion failures propagate so strict callers can observe them;
    // best-effort callers catch at their own boundary.
    await api.deleteSchemaCachePrefix(prefix);
  })().finally(() => {
    if (pendingInvalidations.get(prefix) === deletion) pendingInvalidations.delete(prefix);
  });
  pendingInvalidations.set(prefix, deletion);
  return deletion;
}

export async function loadObjectMetadataFacet<T>(request: ObjectMetadataRequest, facet: ObjectMetadataFacet, loader: () => Promise<T>, options?: { force?: boolean }): Promise<{ value: T; cacheStatus: "memory" | "disk" | "remote" }> {
  const token = activeLoads.begin(facetKey(request, facet));
  try {
    return await waitForMetadata(loadObjectMetadataFacetInternal(request, facet, loader, token.controller.signal, options), metadataLoadBudgetMs(request.queryTimeoutSecs), token.controller.signal);
  } catch (error) {
    token.controller.abort(error);
    throw error;
  } finally {
    activeLoads.finish(token);
  }
}

async function loadObjectMetadataFacetInternal<T>(request: ObjectMetadataRequest, facet: ObjectMetadataFacet, loader: () => Promise<T>, signal: AbortSignal, options?: { force?: boolean }): Promise<{ value: T; cacheStatus: "memory" | "disk" | "remote" }> {
  const cacheKey = facetKey(request, facet);
  if (options?.force) {
    const existing = inFlightLoads.get(cacheKey);
    if (existing?.force) return { value: (await existing.promise) as T, cacheStatus: "remote" };
    invalidateInFlightLoad(cacheKey);
    activeCacheReads.invalidatePrefix(cacheKey);
    invalidateMetadataRuntimeCachePrefix(cacheKey);
    const priorInvalidations = waitForPendingInvalidations(cacheKey);
    const deletion = invalidatePersistedPrefix(cacheKey);
    // A failed prefix deletion must not fail the force load itself.
    await Promise.allSettled([priorInvalidations, deletion]);
  } else {
    await waitForPendingInvalidations(cacheKey);
  }

  signal.throwIfAborted();
  if (!options?.force) {
    const runtime = getMetadataRuntimeCache<T>(cacheKey);
    if (runtime) return { value: runtime.value, cacheStatus: "memory" };
    // A persisted snapshot cannot prove which Agent/plugin is running now.
    if (!request.exactIdentity) {
      const readToken = activeCacheReads.begin(cacheKey);
      let cached: ReturnType<typeof decodeEnvelope<T>>;
      try {
        cached = decodeEnvelope<T>(await waitForMetadata(loadSchemaCacheSafe<unknown>(cacheKey), metadataLoadBudgetMs(request.queryTimeoutSecs), signal));
      } finally {
        activeCacheReads.finish(readToken);
      }
      signal.throwIfAborted();
      if (readToken.invalidated) {
        const value = await loadObjectMetadataFacetInternal(request, facet, loader, signal, { force: false });
        return { value: value.value, cacheStatus: "remote" };
      }
      if (cached?.hit) {
        recordMetadataCacheL2Hit(cacheKey, cached.value);
        setMetadataRuntimeCache(cacheKey, cached.value, request.connectionId);
        return { value: cached.value, cacheStatus: "disk" };
      }
    }
  }

  signal.throwIfAborted();
  const existing = inFlightLoads.get(cacheKey);
  if (existing && (!options?.force || existing.force)) return { value: (await existing.promise) as T, cacheStatus: "remote" };
  if (existing) invalidateInFlightLoad(cacheKey);

  const entry: InFlightLoad<T> = { force: options?.force === true, invalidated: false, promise: Promise.resolve(undefined as T) };
  const cancel = () => {
    entry.invalidated = true;
    if (inFlightLoads.get(cacheKey) === entry) inFlightLoads.delete(cacheKey);
  };
  signal.addEventListener("abort", cancel, { once: true });
  recordMetadataCacheRemoteMiss(cacheKey);
  entry.promise = waitForMetadata(
    loader().then((value) => {
      // Callers use undefined to signal that all metadata fallbacks failed.
      // Keep that result visible to the current request, but do not turn a
      // transient failure into a successful cache hit.
      if (value === undefined) return value;
      const serialized = JSON.stringify(value);
      const current = !entry.invalidated;
      if (current) setMetadataRuntimeCache(cacheKey, value, request.connectionId);
      if (current && !request.exactIdentity && serialized !== undefined && serialized.length <= MAX_PERSISTED_METADATA_CHARS) {
        const envelope: ObjectMetadataCacheEnvelope<T> = { version: 1, cachedAt: new Date().toISOString(), value };
        persistSchemaCache(cacheKey, envelope, () => entry.invalidated);
      }
      return value;
    }),
    metadataLoadBudgetMs(request.queryTimeoutSecs),
    signal,
  ).finally(() => {
    signal.removeEventListener("abort", cancel);
    if (inFlightLoads.get(cacheKey) === entry) inFlightLoads.delete(cacheKey);
  });
  inFlightLoads.set(cacheKey, entry as InFlightLoad<unknown>);
  return { value: await entry.promise, cacheStatus: "remote" };
}

export async function invalidateObjectMetadataCache(match: MetadataCacheInvalidation, options?: ObjectCacheInvalidationOptions): Promise<void> {
  const prefix = invalidationPrefix(match);
  return invalidateFacetPrefix(prefix, options);
}

/** One physical object/facet, including legacy and exact variants of that facet. */
export async function invalidateObjectMetadataFacet(request: ObjectMetadataRequest, facet: ObjectMetadataFacet, options?: ObjectCacheInvalidationOptions): Promise<void> {
  const prefixes = [false, true].map((exactIdentity) => facetKey({ ...request, exactIdentity, oracleTriggerContract: undefined }, facet));
  for (const prefix of prefixes) activeLoads.cancelPrefix(prefix);
  await Promise.all(prefixes.map((prefix) => invalidateFacetPrefix(prefix, options)));
}

async function invalidateFacetPrefix(prefix: string, options?: ObjectCacheInvalidationOptions): Promise<void> {
  activeCacheReads.invalidatePrefix(prefix);
  for (const cacheKey of [...inFlightLoads.keys()]) if (cacheKey.startsWith(prefix)) invalidateInFlightLoad(cacheKey);
  invalidateMetadataRuntimeCachePrefix(prefix);

  const deletion = invalidatePersistedPrefix(prefix);
  if (!options?.strict) {
    await deletion.catch(() => undefined);
    return;
  }
  try {
    await deletion;
  } catch (error) {
    throw toObjectCacheInvalidationError(error, prefix);
  }
}

/** Invalidate active loads for a disconnected connection without deleting its persisted snapshot. */
export function cancelObjectMetadataLoadsForConnection(connectionId: string): void {
  const prefix = `${OBJECT_METADATA_CACHE_PREFIX}:${cacheSegment(connectionId)}:`;
  activeLoads.cancelPrefix(prefix);
  activeCacheReads.invalidatePrefix(prefix);
  for (const cacheKey of [...inFlightLoads.keys()]) if (cacheKey.startsWith(prefix)) invalidateInFlightLoad(cacheKey);
  invalidateMetadataRuntimeCachePrefix(prefix);
}

export function cancelObjectMetadataLoadsForDatabase(connectionId: string, database: string): void {
  const prefix = `${OBJECT_METADATA_CACHE_PREFIX}:${cacheSegment(connectionId)}:${cacheSegment(database)}:`;
  activeLoads.cancelPrefix(prefix);
  activeCacheReads.invalidatePrefix(prefix);
  for (const cacheKey of [...inFlightLoads.keys()]) if (cacheKey.startsWith(prefix)) invalidateInFlightLoad(cacheKey);
  invalidateMetadataRuntimeCachePrefix(prefix);
}

export function getObjectMetadataCacheDebugStateForTests(): { activeReads: number } {
  return { activeReads: activeCacheReads.activeCount };
}
