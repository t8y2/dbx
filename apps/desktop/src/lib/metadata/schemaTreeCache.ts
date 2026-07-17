export const SCHEMA_TREE_CACHE_TTL_MS = 15 * 60 * 1000;

export interface SchemaTreeCacheEnvelope<T> {
  version: 2;
  cachedAt: string;
  children: T;
}

export interface DecodedSchemaTreeCache<T> {
  children: T;
  isStale: boolean;
}

export function encodeSchemaTreeCache<T>(children: T, nowMs = Date.now()): SchemaTreeCacheEnvelope<T> {
  return {
    version: 2,
    cachedAt: new Date(nowMs).toISOString(),
    children,
  };
}

export function decodeSchemaTreeCache<T>(payload: unknown, nowMs = Date.now(), ttlMs = SCHEMA_TREE_CACHE_TTL_MS): DecodedSchemaTreeCache<T> | null {
  if (Array.isArray(payload)) {
    return { children: payload as T, isStale: true };
  }

  if (!payload || typeof payload !== "object") return null;

  const envelope = payload as Partial<SchemaTreeCacheEnvelope<unknown>>;
  if (envelope.version !== 2 || !Array.isArray(envelope.children) || typeof envelope.cachedAt !== "string") {
    return null;
  }

  const cachedAtMs = Date.parse(envelope.cachedAt);
  if (!Number.isFinite(cachedAtMs)) return null;

  return {
    children: envelope.children as T,
    isStale: nowMs - cachedAtMs >= ttlMs,
  };
}
