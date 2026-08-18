import type { ColumnInfo, DatabaseType, IndexInfo, QueryTab } from "@/types/database";
import * as api from "@/lib/backend/api";
import { editableRowIdentifierColumns } from "@/lib/table/tableEditing";
import { createMetadataLoadTrace, logMetadataLoadTrace, MetadataLoadCoordinator, type MetadataLoadCacheStatus, type MetadataLoadTraceLogger } from "./metadataLoadCoordinator";
import { metadataScopeKey, metadataScopeParts, type MetadataScopeInput } from "./metadataLoadScope";
import { metadataCacheInvalidationMatcher, MetadataResultCache, type MetadataCacheInvalidation } from "./metadataResultCache";

export const TABLE_METADATA_CACHE_TTL_MS = 30_000;
const TABLE_METADATA_CACHE_MAX_ENTRIES = 120;

export interface TableMetadata {
  schema?: string;
  tableName: string;
  tableType?: string;
  catalog?: string;
  database?: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  primaryKeys: string[];
  cachedAt: number;
}

export interface TableMetadataRequest {
  connectionId: string;
  database: string;
  schema?: string;
  tableName: string;
  tableType?: string;
  databaseType: DatabaseType | string;
  driverProfile?: string;
  catalog?: string;
  force?: boolean;
  traceLogger?: MetadataLoadTraceLogger;
}

export interface TableMetadataLoadResult {
  metadata: TableMetadata;
  cacheStatus: MetadataLoadCacheStatus;
  ageMs: number;
}

/**
 * Columns-only table metadata. Used by read-only/display consumers (e.g. query
 * result column comments for grouped results) that must not pay for index
 * discovery. Shares the same scope/TTL/invalidation contract as the full table
 * metadata cache, and the full loader reuses this column facet so both paths
 * never issue duplicate `getColumns` calls.
 */
export interface TableColumnsMetadata {
  schema?: string;
  tableName: string;
  tableType?: string;
  catalog?: string;
  database?: string;
  columns: ColumnInfo[];
  cachedAt: number;
}

export interface TableColumnsLoadResult {
  columns: ColumnInfo[];
  tableType?: string;
  cacheStatus: MetadataLoadCacheStatus;
  ageMs: number;
  cachedAt: number;
}

const tableMetadataCache = new MetadataResultCache<TableMetadata>({
  ttlMs: TABLE_METADATA_CACHE_TTL_MS,
  maxEntries: TABLE_METADATA_CACHE_MAX_ENTRIES,
});

const tableMetadataCoordinator = new MetadataLoadCoordinator((event) => {
  console.debug("[DBX][metadata-load:table-coordinator]", event);
});
const tableIndexesLoads = new Map<string, { parts: ReturnType<typeof metadataScopeParts>; promise: Promise<IndexInfo[]>; expiresAt: number }>();

// Columns facet: shared by the full table-metadata loader and the display-only
// loader, so a grouped-query comment enrichment and an editable query never
// issue duplicate `getColumns` calls for the same table (and the display path
// never triggers `listIndexes`). Uses the same TTL, scope keys, in-flight
// coordinator and invalidation stamps as the full table metadata cache.
const TABLE_COLUMNS_CACHE_MAX_ENTRIES = 240;
const tableColumnsCache = new MetadataResultCache<TableColumnsMetadata>({
  ttlMs: TABLE_METADATA_CACHE_TTL_MS,
  maxEntries: TABLE_COLUMNS_CACHE_MAX_ENTRIES,
});

const tableColumnsCoordinator = new MetadataLoadCoordinator((event) => {
  console.debug("[DBX][metadata-load:columns-coordinator]", event);
});

interface InFlightTableColumnsScope {
  parts: ReturnType<typeof metadataScopeParts>;
  count: number;
}
const inFlightTableColumnsScopes = new Map<string, InFlightTableColumnsScope>();
const tableColumnsInvalidationStamps = new Map<string, number>();

function registerInFlightTableColumnsScope(scopeKey: string, scope: MetadataScopeInput): void {
  const entry = inFlightTableColumnsScopes.get(scopeKey);
  if (entry) {
    entry.count++;
  } else {
    inFlightTableColumnsScopes.set(scopeKey, { parts: metadataScopeParts(scope), count: 1 });
  }
}

function unregisterInFlightTableColumnsScope(scopeKey: string): void {
  const entry = inFlightTableColumnsScopes.get(scopeKey);
  if (!entry) return;
  entry.count--;
  if (entry.count > 0) return;
  inFlightTableColumnsScopes.delete(scopeKey);
  tableColumnsInvalidationStamps.delete(scopeKey);
}

function bumpTableColumnsInvalidationStamp(scopeKey: string): void {
  tableColumnsInvalidationStamps.set(scopeKey, (tableColumnsInvalidationStamps.get(scopeKey) ?? 0) + 1);
}

// 失效代数（按 scope key 隔离）：跨越失效边界的旧加载完成后不得写缓存——
// 结构变更后 force 拉到的新值可能被保存前启动、最后返回的在途加载回填覆盖。
// 只登记在途 scope 并只对匹配失效条件的 key 递增代数，避免失效表 A 时
// 波及无关表 B 的在途去重与缓存写入
interface InFlightTableMetadataScope {
  parts: ReturnType<typeof metadataScopeParts>;
  count: number;
}
const inFlightTableMetadataScopes = new Map<string, InFlightTableMetadataScope>();
const tableMetadataInvalidationStamps = new Map<string, number>();

function registerInFlightTableMetadataScope(scopeKey: string, scope: MetadataScopeInput): void {
  const entry = inFlightTableMetadataScopes.get(scopeKey);
  if (entry) {
    entry.count++;
  } else {
    inFlightTableMetadataScopes.set(scopeKey, { parts: metadataScopeParts(scope), count: 1 });
  }
}

function unregisterInFlightTableMetadataScope(scopeKey: string): void {
  const entry = inFlightTableMetadataScopes.get(scopeKey);
  if (!entry) return;
  entry.count--;
  if (entry.count > 0) return;
  inFlightTableMetadataScopes.delete(scopeKey);
  // 代数只在加载的 start→end 窗口内比较，且失效只 bump 在途 key；
  // 无在途加载时清掉代数，两张 Map 都随在途集合有界
  tableMetadataInvalidationStamps.delete(scopeKey);
}

function bumpTableMetadataInvalidationStamp(scopeKey: string): void {
  tableMetadataInvalidationStamps.set(scopeKey, (tableMetadataInvalidationStamps.get(scopeKey) ?? 0) + 1);
}

export function tableMetadataScope(request: Pick<TableMetadataRequest, "connectionId" | "database" | "schema" | "tableName" | "tableType" | "driverProfile" | "databaseType" | "catalog">): MetadataScopeInput {
  return {
    kind: "table-metadata",
    connectionId: request.connectionId,
    database: request.database,
    schema: request.schema ?? "",
    tableName: request.tableName,
    tableType: request.tableType,
    driverProfile: request.driverProfile || request.databaseType,
    extra: request.catalog ? { catalog: request.catalog } : undefined,
  };
}

export function getCachedTableMetadata(request: Pick<TableMetadataRequest, "connectionId" | "database" | "schema" | "tableName" | "tableType" | "driverProfile" | "databaseType" | "catalog">): TableMetadataLoadResult | undefined {
  const hit = tableMetadataCache.get(tableMetadataScope(request));
  if (!hit) return undefined;
  return { metadata: hit.value, cacheStatus: hit.stale ? "stale" : "hit", ageMs: hit.ageMs };
}

export function getCachedTableColumns(request: Pick<TableMetadataRequest, "connectionId" | "database" | "schema" | "tableName" | "tableType" | "driverProfile" | "databaseType" | "catalog">): TableColumnsLoadResult | undefined {
  const hit = tableColumnsCache.get(tableMetadataScope(request));
  if (!hit) return undefined;
  return { columns: hit.value.columns, tableType: hit.value.tableType, cacheStatus: hit.stale ? "stale" : "hit", ageMs: hit.ageMs, cachedAt: hit.cachedAt };
}

/**
 * Load only the column metadata for a table, with the same TTL cache, in-flight
 * deduplication and invalidation contract as full table metadata.
 *
 * Reuse rules (guaranteed by this implementation and asserted in the request
 * counts regression tests):
 *
 * - Case A: if a fresh full table-metadata entry already exists for the table,
 *   its columns are returned directly — a display enrichment never re-fetches
 *   columns (or indexes).
 * - If a fresh columns-only entry exists, it is returned with no remote call.
 * - Absent a cache hit, a single remote `api.getColumns` is issued (no
 *   `listIndexes`), deduplicated for concurrent callers via the shared columns
 *   coordinator.
 */
export async function loadTableColumns(request: TableMetadataRequest): Promise<TableColumnsLoadResult> {
  const scope = tableMetadataScope(request);
  const trace = createMetadataLoadTrace(scope);
  if (!request.force) {
    // Case A: reuse a fresh full table-metadata cache entry so a display
    // enrichment that follows a full metadata load issues zero remote calls.
    const full = tableMetadataCache.get(scope);
    if (full) {
      logMetadataLoadTrace(request.traceLogger, trace, "cache-hit", {
        cacheStatus: full.stale ? "stale" : "hit",
        resultCount: full.value.columns.length,
        stale: full.stale,
      });
      return { columns: full.value.columns, tableType: full.value.tableType, cacheStatus: full.stale ? "stale" : "hit", ageMs: full.ageMs, cachedAt: full.cachedAt };
    }
    const cached = tableColumnsCache.get(scope);
    if (cached) {
      logMetadataLoadTrace(request.traceLogger, trace, "cache-hit", {
        cacheStatus: cached.stale ? "stale" : "hit",
        resultCount: cached.value.columns.length,
        stale: cached.stale,
      });
      return { columns: cached.value.columns, tableType: cached.value.tableType, cacheStatus: cached.stale ? "stale" : "hit", ageMs: cached.ageMs, cachedAt: cached.cachedAt };
    }
  }

  logMetadataLoadTrace(request.traceLogger, trace, "cache-miss", { cacheStatus: request.force ? "refresh" : "miss", force: request.force === true });
  const scopeKey = metadataScopeKey(scope);
  const invalidationStampAtStart = tableColumnsInvalidationStamps.get(scopeKey) ?? 0;
  registerInFlightTableColumnsScope(scopeKey, scope);
  let metadata: TableColumnsMetadata;
  try {
    metadata = await tableColumnsCoordinator.run(
      scope,
      async () => {
        // Display-only loader: columns only, never index discovery.
        const columns = await api.getColumns(request.connectionId, request.database, request.schema ?? "", request.tableName, request.catalog);
        return {
          schema: request.schema || undefined,
          tableName: request.tableName,
          tableType: request.tableType,
          catalog: request.catalog,
          database: request.database,
          columns,
          cachedAt: Date.now(),
        };
      },
      { force: request.force, kind: scope.kind },
    );

    if (invalidationStampAtStart === (tableColumnsInvalidationStamps.get(scopeKey) ?? 0)) {
      tableColumnsCache.set(scope, metadata);
    }
  } finally {
    unregisterInFlightTableColumnsScope(scopeKey);
  }
  logMetadataLoadTrace(request.traceLogger, trace, "done", {
    cacheStatus: request.force ? "refresh" : "miss",
    resultCount: metadata.columns.length,
    force: request.force === true,
  });
  return { columns: metadata.columns, tableType: metadata.tableType, cacheStatus: request.force ? "refresh" : "miss", ageMs: 0, cachedAt: metadata.cachedAt };
}

export function tableMetadataToDataTabMeta(metadata: TableMetadata, overrides?: { schema?: string }): NonNullable<QueryTab["tableMeta"]> {
  return {
    schema: overrides ? overrides.schema : metadata.schema,
    tableName: metadata.tableName,
    tableType: metadata.tableType,
    catalog: metadata.catalog,
    database: metadata.database,
    columns: metadata.columns,
    primaryKeys: metadata.primaryKeys,
  };
}

export async function loadTableIndexes(request: TableMetadataRequest): Promise<IndexInfo[]> {
  const scope = tableMetadataScope(request);
  const scopeKey = metadataScopeKey(scope);
  const cached = tableIndexesLoads.get(scopeKey);
  if (!request.force && cached && cached.expiresAt > Date.now()) return cached.promise;
  if (cached) tableIndexesLoads.delete(scopeKey);
  while (tableIndexesLoads.size >= TABLE_METADATA_CACHE_MAX_ENTRIES) {
    const oldestKey = tableIndexesLoads.keys().next().value;
    if (!oldestKey) break;
    tableIndexesLoads.delete(oldestKey);
  }
  const promise = api.listIndexes(request.connectionId, request.database, request.schema ?? "", request.tableName, request.catalog);
  const entry = { parts: metadataScopeParts(scope), promise, expiresAt: Date.now() + TABLE_METADATA_CACHE_TTL_MS };
  tableIndexesLoads.set(scopeKey, entry);
  void promise.catch(() => {
    if (tableIndexesLoads.get(scopeKey) === entry) tableIndexesLoads.delete(scopeKey);
  });
  return promise;
}

export async function loadTableMetadata(request: TableMetadataRequest): Promise<TableMetadataLoadResult> {
  const scope = tableMetadataScope(request);
  const trace = createMetadataLoadTrace(scope);
  if (!request.force) {
    const cached = tableMetadataCache.get(scope);
    if (cached) {
      logMetadataLoadTrace(request.traceLogger, trace, "cache-hit", {
        cacheStatus: cached.stale ? "stale" : "hit",
        resultCount: cached.value.columns.length,
        stale: cached.stale,
      });
      return { metadata: cached.value, cacheStatus: cached.stale ? "stale" : "hit", ageMs: cached.ageMs };
    }
  }

  logMetadataLoadTrace(request.traceLogger, trace, "cache-miss", { cacheStatus: request.force ? "refresh" : "miss", force: request.force === true });
  const scopeKey = metadataScopeKey(scope);
  const invalidationStampAtStart = tableMetadataInvalidationStamps.get(scopeKey) ?? 0;
  registerInFlightTableMetadataScope(scopeKey, scope);
  let metadata: TableMetadata;
  try {
    // Start the columns facet synchronously (before the first await) so its
    // in-flight registration is visible to any synchronous invalidation that
    // follows — otherwise a follower could dedupe against a stale column load
    // that invalidation was too early to clear. Concurrent display-only column
    // requests dedupe against this same coordinator entry.
    const columnsPromise = loadTableColumns(request);
    metadata = await tableMetadataCoordinator.run(
      scope,
      async () => {
        // Column discovery can be especially slow on Oracle. Start row-identity
        // discovery independently unless an unqualified Vastbase relation must
        // first report its visible schema for the index lookup.
        const resolveVastbaseSchema = request.databaseType === "vastbase" && !request.schema;
        const indexesPromise = resolveVastbaseSchema ? undefined : loadTableIndexes(request).catch((): IndexInfo[] => []);
        const columnsResult = await columnsPromise;
        const columns = columnsResult.columns;
        const resolvedSchema = resolveVastbaseSchema ? columns.find((column) => column.resolved_schema)?.resolved_schema : request.schema;
        const indexes = columns.length > 0 ? await (indexesPromise ?? loadTableIndexes({ ...request, schema: resolvedSchema }).catch((): IndexInfo[] => [])) : [];
        const primaryKeys = editableRowIdentifierColumns(request.databaseType as DatabaseType, columns, indexes, request.tableType);
        return {
          schema: resolvedSchema || undefined,
          tableName: request.tableName,
          tableType: request.tableType,
          catalog: request.catalog,
          database: request.database,
          columns,
          indexes,
          primaryKeys,
          cachedAt: columnsResult.cachedAt,
        };
      },
      { force: request.force, kind: scope.kind },
    );

    // 必须在 unregister 前比较：最后一个在途加载注销时会顺带清掉代数记录
    if (invalidationStampAtStart === (tableMetadataInvalidationStamps.get(scopeKey) ?? 0)) {
      tableMetadataCache.set(scope, metadata, { cachedAt: metadata.cachedAt });
    }
  } finally {
    unregisterInFlightTableMetadataScope(scopeKey);
  }
  logMetadataLoadTrace(request.traceLogger, trace, "done", {
    cacheStatus: request.force ? "refresh" : "miss",
    resultCount: metadata.columns.length,
    force: request.force === true,
  });
  return { metadata, cacheStatus: request.force ? "refresh" : "miss", ageMs: 0 };
}

export function invalidateTableMetadataCache(match: MetadataCacheInvalidation): number {
  // 只处理匹配失效条件的在途 scope，不波及其他表/连接的在途去重与缓存写入：
  // 1) bump 该 scope 的失效代数——跨边界的旧加载完成后不得写缓存；
  // 2) 甩掉该 scope 的在途登记——否则失效后启动的 non-force 调用会加入
  //    失效前的旧加载，且其失效代数取自失效之后，完成时把旧结果写回缓存
  const matches = metadataCacheInvalidationMatcher(match);
  for (const [scopeKey, entry] of inFlightTableMetadataScopes) {
    if (!matches(entry.parts)) continue;
    bumpTableMetadataInvalidationStamp(scopeKey);
    tableMetadataCoordinator.clear(scopeKey);
  }
  // Same invalidation contract for the columns facet: stale in-flight column
  // results must not write back across the invalidation boundary either.
  for (const [scopeKey, entry] of inFlightTableColumnsScopes) {
    if (!matches(entry.parts)) continue;
    bumpTableColumnsInvalidationStamp(scopeKey);
    tableColumnsCoordinator.clear(scopeKey);
  }
  for (const [scopeKey, entry] of tableIndexesLoads) {
    if (matches(entry.parts)) tableIndexesLoads.delete(scopeKey);
  }
  const removedFull = tableMetadataCache.invalidate(match);
  // Columns facet is invalidated as a side effect but, to preserve the existing
  // public return contract (count of table-metadata entries invalidated), it is
  // not added to the returned total.
  tableColumnsCache.invalidate(match);
  return removedFull;
}

export function clearTableMetadataCache(): void {
  for (const scopeKey of inFlightTableMetadataScopes.keys()) {
    bumpTableMetadataInvalidationStamp(scopeKey);
  }
  for (const scopeKey of inFlightTableColumnsScopes.keys()) {
    bumpTableColumnsInvalidationStamp(scopeKey);
  }
  tableMetadataCoordinator.clear();
  tableColumnsCoordinator.clear();
  tableIndexesLoads.clear();
  tableMetadataCache.clear();
  tableColumnsCache.clear();
}
