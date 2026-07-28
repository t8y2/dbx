import type { MetadataScopeInput } from "@/lib/metadata/metadataLoadScope";
import { MetadataResultCache, type MetadataCacheInvalidation } from "@/lib/metadata/metadataResultCache";
import type { ObjectBrowserRow } from "@/lib/table/objectBrowserRows";

const OBJECT_BROWSER_ROWS_CACHE_TTL_MS = 30_000;
const OBJECT_BROWSER_ROWS_CACHE_MAX_ENTRIES = 24;

export interface ObjectBrowserRowsCacheScope {
  connectionId: string;
  database: string;
  schema: string;
  catalog?: string;
}

const objectBrowserRowsCache = new MetadataResultCache<ObjectBrowserRow[]>({
  ttlMs: OBJECT_BROWSER_ROWS_CACHE_TTL_MS,
  maxEntries: OBJECT_BROWSER_ROWS_CACHE_MAX_ENTRIES,
});

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

export function getCachedObjectBrowserRows(scope: ObjectBrowserRowsCacheScope): ObjectBrowserRow[] | undefined {
  const hit = objectBrowserRowsCache.get(objectBrowserRowsScope(scope), { allowStale: true });
  return hit ? cloneRows(hit.value) : undefined;
}

export function cacheObjectBrowserRows(scope: ObjectBrowserRowsCacheScope, rows: readonly ObjectBrowserRow[]): void {
  objectBrowserRowsCache.set(objectBrowserRowsScope(scope), cloneRows(rows));
}

export function invalidateObjectBrowserRowsCache(match: MetadataCacheInvalidation): number {
  return objectBrowserRowsCache.invalidate(match);
}

export function clearObjectBrowserRowsCache(): void {
  objectBrowserRowsCache.clear();
}
