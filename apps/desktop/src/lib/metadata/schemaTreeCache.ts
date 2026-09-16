export const SCHEMA_TREE_CACHE_TTL_MS = 15 * 60 * 1000;

export interface TableSearchIndexEntry {
  name: string;
  tableType: string;
  comment?: string | null;
}

export interface TableSearchIndex {
  complete: true;
  indexedAt: string;
  entries: TableSearchIndexEntry[];
}

/** Stable scope metadata used to discover complete local indexes without
 * walking or expanding the live connection tree. */
export interface TableSearchIndexManifestEntry {
  cacheKey: string;
  parentNodeId: string;
  connectionId: string;
  database: string;
  schema?: string;
  catalog?: string;
  nodeType: string;
  path?: Array<Pick<import("@/types/database").TreeNode, "id" | "label" | "type" | "connectionId" | "database" | "catalog" | "schema" | "linkedServer" | "linkedCatalog" | "linkedSchema">>;
}

export interface TableSearchIndexManifest {
  version: 1;
  scopes: TableSearchIndexManifestEntry[];
}

export function encodeTableSearchIndexManifest(scopes: readonly TableSearchIndexManifestEntry[]): TableSearchIndexManifest {
  return { version: 1, scopes: [...scopes] };
}

export function decodeTableSearchIndexManifest(payload: unknown): TableSearchIndexManifestEntry[] {
  if (!payload || typeof payload !== "object") return [];
  const value = payload as Partial<TableSearchIndexManifest>;
  if (value.version !== 1 || !Array.isArray(value.scopes)) return [];
  return value.scopes.filter(
    (scope): scope is TableSearchIndexManifestEntry =>
      !!scope &&
      typeof scope === "object" &&
      typeof scope.cacheKey === "string" &&
      typeof scope.parentNodeId === "string" &&
      typeof scope.connectionId === "string" &&
      typeof scope.database === "string" &&
      typeof scope.nodeType === "string" &&
      (scope.path === undefined || (Array.isArray(scope.path) && scope.path.every((node) => !!node && typeof node.id === "string" && typeof node.label === "string" && typeof node.type === "string"))) &&
      (scope.schema === undefined || typeof scope.schema === "string") &&
      (scope.catalog === undefined || typeof scope.catalog === "string"),
  );
}

export interface SchemaTreeCacheEnvelope<T> {
  version: 3;
  cachedAt: string;
  children: T;
  tableSearchIndex?: TableSearchIndex;
}

export interface DecodedSchemaTreeCache<T> {
  children: T;
  isStale: boolean;
  tableSearchIndex?: TableSearchIndex;
}

export function encodeSchemaTreeCache<T>(children: T, nowMs = Date.now(), tableSearchIndex?: TableSearchIndex): SchemaTreeCacheEnvelope<T> {
  return {
    version: 3,
    cachedAt: new Date(nowMs).toISOString(),
    children,
    ...(tableSearchIndex ? { tableSearchIndex } : {}),
  };
}

function decodeTableSearchIndex(value: unknown): TableSearchIndex | undefined {
  if (!value || typeof value !== "object") return undefined;
  const index = value as Partial<TableSearchIndex>;
  if (index.complete !== true || typeof index.indexedAt !== "string" || !Array.isArray(index.entries)) return undefined;
  const entries = index.entries.filter((entry): entry is TableSearchIndexEntry => !!entry && typeof entry.name === "string" && typeof entry.tableType === "string" && (entry.comment === undefined || entry.comment === null || typeof entry.comment === "string"));
  return entries.length === index.entries.length ? { complete: true, indexedAt: index.indexedAt, entries } : undefined;
}

export function decodeSchemaTreeCache<T>(payload: unknown, nowMs = Date.now(), ttlMs = SCHEMA_TREE_CACHE_TTL_MS): DecodedSchemaTreeCache<T> | null {
  if (Array.isArray(payload)) {
    return { children: payload as T, isStale: true };
  }

  if (!payload || typeof payload !== "object") return null;

  const envelope = payload as { version?: unknown; cachedAt?: unknown; children?: unknown; tableSearchIndex?: unknown };
  if ((envelope.version !== 2 && envelope.version !== 3) || !Array.isArray(envelope.children) || typeof envelope.cachedAt !== "string") {
    return null;
  }

  const cachedAtMs = Date.parse(envelope.cachedAt);
  if (!Number.isFinite(cachedAtMs)) return null;

  const tableSearchIndex = decodeTableSearchIndex(envelope.tableSearchIndex);
  return {
    children: envelope.children as T,
    isStale: nowMs - cachedAtMs >= ttlMs,
    ...(tableSearchIndex ? { tableSearchIndex } : {}),
  };
}
