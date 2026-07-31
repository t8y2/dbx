import * as api from "@/lib/backend/api";
import type { ObjectSourceKind } from "@/types/database";
import type { MetadataCacheInvalidation } from "./metadataResultCache";
import { invalidateObjectMetadataCache } from "./objectMetadataCache";

const OBJECT_DDL_CACHE_PREFIX = "object-ddl:v1";
const MAX_PERSISTED_DDL_CHARS = 5 * 1024 * 1024;

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
  cacheStatus: "disk" | "remote";
}

const remoteLoads = new Map<string, InFlightDdlLoad>();
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
  if (envelope.version !== 1 || typeof envelope.cachedAt !== "string" || !Number.isFinite(Date.parse(envelope.cachedAt)) || typeof envelope.ddl !== "string") return null;
  return envelope.ddl;
}

async function waitForPendingInvalidations(cacheKey: string): Promise<void> {
  const pending = [...pendingInvalidations.entries()].filter(([prefix]) => cacheKey.startsWith(prefix)).map(([, promise]) => promise);
  if (pending.length) await Promise.all(pending);
}

async function loadRemoteDdl(request: ObjectDdlRequest, cacheKey: string, force: boolean): Promise<string> {
  const existing = remoteLoads.get(cacheKey);
  if (existing && (!force || existing.force)) return existing.promise;
  if (existing) {
    existing.invalidated = true;
    remoteLoads.delete(cacheKey);
  }

  const entry: InFlightDdlLoad = { force, invalidated: false, promise: Promise.resolve("") };
  entry.promise = api
    .getTableDisplayDdl(request.connectionId, request.database, request.schema, request.tableName, request.objectType, request.catalog)
    .then(async (ddl) => {
      if (!entry.invalidated && ddl.length <= MAX_PERSISTED_DDL_CHARS) {
        const envelope: ObjectDdlCacheEnvelope = { version: 1, cachedAt: new Date().toISOString(), ddl };
        await saveSchemaCacheSafe(cacheKey, envelope);
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
  await waitForPendingInvalidations(cacheKey);

  if (!options?.force) {
    const cached = decodeCachedDdl(await loadSchemaCacheSafe<unknown>(cacheKey));
    if (cached !== null) return { ddl: cached, cacheStatus: "disk" };
  }

  return { ddl: await loadRemoteDdl(request, cacheKey, options?.force === true), cacheStatus: "remote" };
}

export async function invalidateObjectDdlCache(match: MetadataCacheInvalidation): Promise<void> {
  const prefix = invalidationPrefix(match);
  for (const [cacheKey, entry] of remoteLoads) {
    if (!cacheKey.startsWith(prefix)) continue;
    entry.invalidated = true;
    remoteLoads.delete(cacheKey);
  }

  const existing = pendingInvalidations.get(prefix);
  if (existing) return existing;
  const deletion = deleteSchemaCachePrefixSafe(prefix).finally(() => {
    if (pendingInvalidations.get(prefix) === deletion) pendingInvalidations.delete(prefix);
  });
  pendingInvalidations.set(prefix, deletion);
  await Promise.all([deletion, invalidateObjectMetadataCache(match)]);
}

export async function invalidateObjectDdl(request: ObjectDdlRequest): Promise<void> {
  const cacheKey = objectDdlCacheKey(request);
  const entry = remoteLoads.get(cacheKey);
  if (entry) {
    entry.invalidated = true;
    remoteLoads.delete(cacheKey);
  }
  await Promise.all([
    deleteSchemaCachePrefixSafe(cacheKey),
    invalidateObjectMetadataCache({
      connectionId: request.connectionId,
      database: request.database,
      schema: request.schema,
      tableName: request.tableName,
    }),
  ]);
}
