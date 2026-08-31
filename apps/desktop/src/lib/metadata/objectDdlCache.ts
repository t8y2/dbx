import * as api from "@/lib/backend/api";
import { ActiveCacheReadTracker } from "./activeCacheReadTracker";
import type { ObjectSourceKind } from "@/types/database";
import type { MetadataCacheInvalidation } from "./metadataResultCache";
import { invalidateObjectMetadataCache } from "./objectMetadataCache";
import { getMetadataRuntimeCache, invalidateMetadataRuntimeCachePrefix, recordMetadataCacheL2Hit, recordMetadataCacheRemoteMiss, setMetadataRuntimeCache } from "./metadataRuntimeCache";

const OBJECT_DDL_CACHE_PREFIX = "object-ddl:v1";
const MAX_PERSISTED_DDL_CHARS = 5 * 1024 * 1024;
const MAX_PERSISTED_DDL_AGE_MS = 24 * 60 * 60 * 1000;

interface ObjectDdlCacheEnvelope {
  version: 1;
  cachedAt: string;
  ddl: string;
}

interface InFlightDdlLoad {
  force: boolean;
  invalidated: boolean;
  promise: Promise<string>;
}

export interface ObjectDdlRequest {
  connectionId: string;
  database: string;
  schema: string;
  tableName: string;
  objectType?: ObjectSourceKind;
  catalog?: string;
}

export interface ObjectDdlLoadResult {
  ddl: string;
  cacheStatus: "memory" | "disk" | "remote";
}

const remoteLoads = new Map<string, InFlightDdlLoad>();
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
    // Cache persistence is best effort and must not block DDL rendering.
  }
}

async function deleteSchemaCachePrefixSafe(prefix: string): Promise<void> {
  try {
    await api.deleteSchemaCachePrefix(prefix);
  } catch {
    // Cache invalidation is best effort when running with a reduced backend.
  }
}

function cacheSegment(value: string | undefined): string {
  return encodeURIComponent(value ?? "");
}

export function objectDdlCacheKey(request: ObjectDdlRequest): string {
  return `${[OBJECT_DDL_CACHE_PREFIX, cacheSegment(request.connectionId), cacheSegment(request.database), cacheSegment(request.schema), cacheSegment(request.tableName), cacheSegment(request.catalog), cacheSegment(request.objectType ?? "TABLE")].join(":")}:`;
}

function invalidationPrefix(match: MetadataCacheInvalidation): string {
  const parts = [OBJECT_DDL_CACHE_PREFIX];
  if (!match.connectionId) return `${OBJECT_DDL_CACHE_PREFIX}:`;
  parts.push(cacheSegment(match.connectionId ?? undefined));
  if (!match.database) return `${parts.join(":")}:`;
  parts.push(cacheSegment(match.database ?? undefined));
  if (!match.schema) return `${parts.join(":")}:`;
  parts.push(cacheSegment(match.schema ?? undefined));
  if (!match.tableName) return `${parts.join(":")}:`;
  parts.push(cacheSegment(match.tableName));
  return `${parts.join(":")}:`;
}

function decodeCachedDdl(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const envelope = payload as Partial<ObjectDdlCacheEnvelope>;
  const cachedAt = typeof envelope.cachedAt === "string" ? Date.parse(envelope.cachedAt) : Number.NaN;
  if (envelope.version !== 1 || !Number.isFinite(cachedAt) || Date.now() - cachedAt > MAX_PERSISTED_DDL_AGE_MS || typeof envelope.ddl !== "string") return null;
  return envelope.ddl;
}

async function waitForPendingInvalidations(cacheKey: string): Promise<void> {
  const pending = [...pendingInvalidations.entries()].filter(([prefix]) => cacheKey.startsWith(prefix)).map(([, promise]) => promise);
  if (pending.length) await Promise.all(pending);
}

function invalidateRemoteLoad(cacheKey: string): void {
  const entry = remoteLoads.get(cacheKey);
  if (!entry) return;
  entry.invalidated = true;
  remoteLoads.delete(cacheKey);
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

async function loadRemoteDdl(request: ObjectDdlRequest, cacheKey: string, force: boolean): Promise<string> {
  const existing = remoteLoads.get(cacheKey);
  if (existing && (!force || existing.force)) return existing.promise;
  if (existing) invalidateRemoteLoad(cacheKey);

  const entry: InFlightDdlLoad = { force, invalidated: false, promise: Promise.resolve("") };
  recordMetadataCacheRemoteMiss(cacheKey);
  entry.promise = api
    .getTableDisplayDdl(request.connectionId, request.database, request.schema, request.tableName, request.objectType, request.catalog)
    .then((ddl) => {
      const current = !entry.invalidated;
      if (current && ddl.length <= MAX_PERSISTED_DDL_CHARS) {
        const envelope: ObjectDdlCacheEnvelope = { version: 1, cachedAt: new Date().toISOString(), ddl };
        setMetadataRuntimeCache(cacheKey, ddl, request.connectionId);
        persistSchemaCache(cacheKey, envelope, () => entry.invalidated);
      } else if (current) {
        setMetadataRuntimeCache(cacheKey, ddl, request.connectionId);
      }
      return ddl;
    })
    .finally(() => {
      if (remoteLoads.get(cacheKey) === entry) remoteLoads.delete(cacheKey);
    });
  remoteLoads.set(cacheKey, entry);
  return entry.promise;
}

export async function loadObjectDdl(request: ObjectDdlRequest, options?: { force?: boolean }): Promise<ObjectDdlLoadResult> {
  const cacheKey = objectDdlCacheKey(request);
  if (options?.force) {
    const existing = remoteLoads.get(cacheKey);
    if (existing?.force) return { ddl: await existing.promise, cacheStatus: "remote" };
    invalidateRemoteLoad(cacheKey);
    activeCacheReads.invalidatePrefix(cacheKey);
    invalidateMetadataRuntimeCachePrefix(cacheKey);
    const priorInvalidations = waitForPendingInvalidations(cacheKey);
    const deletion = invalidatePersistedPrefix(cacheKey);
    await Promise.all([priorInvalidations, deletion]);
  } else {
    await waitForPendingInvalidations(cacheKey);
  }

  if (!options?.force) {
    const runtime = getMetadataRuntimeCache<string>(cacheKey);
    if (runtime) return { ddl: runtime.value, cacheStatus: "memory" };
    const readToken = activeCacheReads.begin(cacheKey);
    let cached: string | null;
    try {
      cached = decodeCachedDdl(await loadSchemaCacheSafe<unknown>(cacheKey));
    } finally {
      activeCacheReads.finish(readToken);
    }
    if (readToken.invalidated) {
      await waitForPendingInvalidations(cacheKey);
      return { ddl: await loadRemoteDdl(request, cacheKey, false), cacheStatus: "remote" };
    }
    if (cached !== null) {
      recordMetadataCacheL2Hit(cacheKey, cached);
      setMetadataRuntimeCache(cacheKey, cached, request.connectionId);
      return { ddl: cached, cacheStatus: "disk" };
    }
  }

  return { ddl: await loadRemoteDdl(request, cacheKey, options?.force === true), cacheStatus: "remote" };
}

export async function invalidateObjectDdlCache(match: MetadataCacheInvalidation): Promise<void> {
  const prefix = invalidationPrefix(match);
  activeCacheReads.invalidatePrefix(prefix);
  for (const cacheKey of [...remoteLoads.keys()]) if (cacheKey.startsWith(prefix)) invalidateRemoteLoad(cacheKey);
  invalidateMetadataRuntimeCachePrefix(prefix);

  const deletion = invalidatePersistedPrefix(prefix);
  await Promise.all([deletion, invalidateObjectMetadataCache(match)]);
}

export async function invalidateObjectDdl(request: ObjectDdlRequest): Promise<void> {
  const cacheKey = objectDdlCacheKey(request);
  activeCacheReads.invalidatePrefix(cacheKey);
  invalidateRemoteLoad(cacheKey);
  invalidateMetadataRuntimeCachePrefix(cacheKey);
  await Promise.all([
    invalidatePersistedPrefix(cacheKey),
    invalidateObjectMetadataCache({
      connectionId: request.connectionId,
      database: request.database,
      schema: request.schema,
      tableName: request.tableName,
    }),
  ]);
}

/** Invalidate active loads for a disconnected connection without deleting its persisted snapshot. */
export function cancelObjectDdlLoadsForConnection(connectionId: string): void {
  const prefix = `${OBJECT_DDL_CACHE_PREFIX}:${cacheSegment(connectionId)}:`;
  activeCacheReads.invalidatePrefix(prefix);
  for (const cacheKey of [...remoteLoads.keys()]) if (cacheKey.startsWith(prefix)) invalidateRemoteLoad(cacheKey);
  invalidateMetadataRuntimeCachePrefix(prefix);
}

export function cancelObjectDdlLoadsForDatabase(connectionId: string, database: string): void {
  const prefix = `${OBJECT_DDL_CACHE_PREFIX}:${cacheSegment(connectionId)}:${cacheSegment(database)}:`;
  activeCacheReads.invalidatePrefix(prefix);
  for (const cacheKey of [...remoteLoads.keys()]) if (cacheKey.startsWith(prefix)) invalidateRemoteLoad(cacheKey);
  invalidateMetadataRuntimeCachePrefix(prefix);
}

export function getObjectDdlCacheDebugStateForTests(): { activeReads: number } {
  return { activeReads: activeCacheReads.activeCount };
}
