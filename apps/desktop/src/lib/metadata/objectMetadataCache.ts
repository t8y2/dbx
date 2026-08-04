import * as api from "@/lib/backend/api";
import type { MetadataCacheInvalidation } from "./metadataResultCache";
import type { ObjectDdlRequest } from "./objectDdlCache";

const OBJECT_METADATA_CACHE_PREFIX = "object-meta:v1";
const MAX_PERSISTED_METADATA_CHARS = 5 * 1024 * 1024;

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
const pendingInvalidations = new Map<string, Promise<void>>();

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

export type ObjectMetadataFacet = "columns" | "indexes" | "foreign-keys" | "triggers" | "comment";

function cacheSegment(value: string | undefined): string {
  return encodeURIComponent(value ?? "");
}

function facetKey(request: ObjectDdlRequest, facet: ObjectMetadataFacet): string {
  return `${[OBJECT_METADATA_CACHE_PREFIX, cacheSegment(request.connectionId), cacheSegment(request.database), cacheSegment(request.schema), cacheSegment(request.tableName), cacheSegment(request.catalog), facet].join(":")}:`;
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

function decodeEnvelope<T>(payload: unknown): T | null {
  if (!payload || typeof payload !== "object") return null;
  const envelope = payload as Partial<ObjectMetadataCacheEnvelope<T>>;
  if (envelope.version !== 1 || typeof envelope.cachedAt !== "string" || !Number.isFinite(Date.parse(envelope.cachedAt)) || !("value" in envelope)) return null;
  return envelope.value === undefined ? null : envelope.value;
}

async function waitForPendingInvalidations(cacheKey: string): Promise<void> {
  const pending = [...pendingInvalidations.entries()].filter(([prefix]) => cacheKey.startsWith(prefix)).map(([, promise]) => promise);
  if (pending.length) await Promise.all(pending);
}

export async function loadObjectMetadataFacet<T>(request: ObjectDdlRequest, facet: ObjectMetadataFacet, loader: () => Promise<T>, options?: { force?: boolean }): Promise<{ value: T; cacheStatus: "disk" | "remote" }> {
  const cacheKey = facetKey(request, facet);
  await waitForPendingInvalidations(cacheKey);

  if (!options?.force) {
    const cached = decodeEnvelope<T>(await loadSchemaCacheSafe<unknown>(cacheKey));
    if (cached !== null) return { value: cached, cacheStatus: "disk" };
  }

  const existing = inFlightLoads.get(cacheKey);
  if (existing && (!options?.force || existing.force)) return { value: (await existing.promise) as T, cacheStatus: "remote" };
  if (existing) {
    existing.invalidated = true;
    inFlightLoads.delete(cacheKey);
  }

  const entry: InFlightLoad<T> = { force: options?.force === true, invalidated: false, promise: Promise.resolve(undefined as T) };
  entry.promise = loader()
    .then(async (value) => {
      const serialized = JSON.stringify(value);
      if (!entry.invalidated && serialized.length <= MAX_PERSISTED_METADATA_CHARS) {
        const envelope: ObjectMetadataCacheEnvelope<T> = { version: 1, cachedAt: new Date().toISOString(), value };
        await saveSchemaCacheSafe(cacheKey, envelope);
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
  for (const [cacheKey, entry] of inFlightLoads) {
    if (!cacheKey.startsWith(prefix)) continue;
    entry.invalidated = true;
    inFlightLoads.delete(cacheKey);
  }

  const existing = pendingInvalidations.get(prefix);
  if (existing) return existing;
  const deletion = deleteSchemaCachePrefixSafe(prefix).finally(() => {
    if (pendingInvalidations.get(prefix) === deletion) pendingInvalidations.delete(prefix);
  });
  pendingInvalidations.set(prefix, deletion);
  return deletion;
}
