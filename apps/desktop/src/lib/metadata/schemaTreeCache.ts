export const SCHEMA_TREE_CACHE_TTL_MS = 15 * 60 * 1000;

export interface TableSearchIndexEntry {
  name: string;
  tableType: string;
}

export interface TableSearchIndex {
  complete: true;
  indexedAt: string;
  entries: TableSearchIndexEntry[];
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
  const entries = index.entries.filter((entry): entry is TableSearchIndexEntry => !!entry && typeof entry.name === "string" && typeof entry.tableType === "string");
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
