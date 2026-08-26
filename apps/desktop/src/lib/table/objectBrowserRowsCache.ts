import { metadataScopeKey, metadataScopeParts, type MetadataScopeInput } from "@/lib/metadata/metadataLoadScope";
import { metadataCacheInvalidationMatcher, MetadataResultCache, type MetadataCacheInvalidation } from "@/lib/metadata/metadataResultCache";
import type { ObjectBrowserRow } from "@/lib/table/objectBrowserRows";

const OBJECT_BROWSER_ROWS_CACHE_TTL_MS = 30_000;
const OBJECT_BROWSER_ROWS_CACHE_MAX_ENTRIES = 24;
const OBJECT_BROWSER_ROWS_GENERATION_MAX_ENTRIES = 128;

export interface ObjectBrowserRowsCacheScope {
  connectionId: string;
  database: string;
  schema: string;
  catalog?: string;
}

export interface ObjectBrowserRowsCacheWriteToken {
  generation: number;
  scope: Readonly<ObjectBrowserRowsCacheScope>;
}

interface ObjectBrowserRowsCacheGeneration {
  generation: number;
  scope: ReturnType<typeof metadataScopeParts>;
}

const objectBrowserRowsCache = new MetadataResultCache<ObjectBrowserRow[]>({
  ttlMs: OBJECT_BROWSER_ROWS_CACHE_TTL_MS,
  maxEntries: OBJECT_BROWSER_ROWS_CACHE_MAX_ENTRIES,
  now: () => Date.now(),
});
const objectBrowserRowsCacheGenerations = new Map<string, ObjectBrowserRowsCacheGeneration>();
let nextObjectBrowserRowsCacheGeneration = 0;

function objectBrowserRowsScope(scope: ObjectBrowserRowsCacheScope): MetadataScopeInput {
  return {
    kind: "object-browser-rows",
    connectionId: scope.connectionId,
    database: scope.database,
    schema: scope.schema,
    extra: scope.catalog ? { catalog: scope.catalog } : undefined,
  };
}

function cloneRows(rows: readonly ObjectBrowserRow[]): ObjectBrowserRow[] {
  return rows.map((row) => ({ ...row }));
}

function objectBrowserRowsCacheGeneration(scope: ObjectBrowserRowsCacheScope): ObjectBrowserRowsCacheGeneration {
  const cacheScope = objectBrowserRowsScope(scope);
  const key = metadataScopeKey(cacheScope);
  let state = objectBrowserRowsCacheGenerations.get(key);
  if (!state) {
    state = { generation: ++nextObjectBrowserRowsCacheGeneration, scope: metadataScopeParts(cacheScope) };
    objectBrowserRowsCacheGenerations.set(key, state);
    while (objectBrowserRowsCacheGenerations.size > OBJECT_BROWSER_ROWS_GENERATION_MAX_ENTRIES) {
      const oldest = objectBrowserRowsCacheGenerations.keys().next().value;
      if (oldest === undefined) break;
      objectBrowserRowsCacheGenerations.delete(oldest);
    }
  } else {
    objectBrowserRowsCacheGenerations.delete(key);
    objectBrowserRowsCacheGenerations.set(key, state);
  }
  return state;
}

function objectBrowserRowsCacheInvalidation(match: MetadataCacheInvalidation): MetadataCacheInvalidation {
  const projected: MetadataCacheInvalidation = {};
  if (match.kind !== undefined) projected.kind = match.kind;
  if (match.connectionId !== undefined) projected.connectionId = match.connectionId;
  if (match.database !== undefined) projected.database = match.database;
  if (match.schema !== undefined) projected.schema = match.schema;
  return projected;
}

export function getCachedObjectBrowserRows(scope: ObjectBrowserRowsCacheScope): ObjectBrowserRow[] | undefined {
  const hit = objectBrowserRowsCache.get(objectBrowserRowsScope(scope));
  return hit ? cloneRows(hit.value) : undefined;
}

export function createObjectBrowserRowsCacheWriteToken(scope: ObjectBrowserRowsCacheScope): ObjectBrowserRowsCacheWriteToken {
  const frozenScope = Object.freeze({ ...scope });
  return Object.freeze({ generation: objectBrowserRowsCacheGeneration(frozenScope).generation, scope: frozenScope });
}

export function cacheObjectBrowserRows(token: ObjectBrowserRowsCacheWriteToken, rows: readonly ObjectBrowserRow[], options?: { cachedAt?: number }): number | undefined {
  if (objectBrowserRowsCacheGeneration(token.scope).generation !== token.generation) return undefined;
  const cachedAt = options?.cachedAt ?? Date.now();
  objectBrowserRowsCache.set(objectBrowserRowsScope(token.scope), cloneRows(rows), { cachedAt });
  return cachedAt;
}

export function invalidateObjectBrowserRowsCache(match: MetadataCacheInvalidation): number {
  const projected = objectBrowserRowsCacheInvalidation(match);
  const matches = metadataCacheInvalidationMatcher(projected);
  for (const [key, state] of objectBrowserRowsCacheGenerations) {
    if (matches(state.scope)) objectBrowserRowsCacheGenerations.delete(key);
  }
  return objectBrowserRowsCache.invalidate(projected);
}

export function clearObjectBrowserRowsCache(): void {
  objectBrowserRowsCache.clear();
  objectBrowserRowsCacheGenerations.clear();
}
