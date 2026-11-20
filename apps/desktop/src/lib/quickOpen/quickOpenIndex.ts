import { decodeQuickOpenMetadataCache, type QuickOpenMetadataCache } from "@/lib/quickOpen/quickOpenMetadataCache";

const QUICK_OPEN_METADATA_INDEX_UNSUPPORTED_TYPES = new Set([
  "redis",
  "mongodb",
  "dynamodb",
  "elasticsearch",
  "easysearch",
  "meilisearch",
  "solr",
  "couchdb",
  "qdrant",
  "weaviate",
  "chromadb",
  "milvus",
  "victoriametrics",
  "etcd",
  "zookeeper",
  "mq",
  "mqtt",
  "nacos",
  "consul",
  "salesforce",
  "influxdb",
  "influxdb3",
  "neo4j",
  "nebula",
  "plugin",
]);

export function isQuickOpenMetadataIndexSupported(dbType: string): boolean {
  return !QUICK_OPEN_METADATA_INDEX_UNSUPPORTED_TYPES.has(dbType);
}

export type QuickOpenIndexState = "not-built" | "ready" | "building" | "partial" | "failed";

export interface QuickOpenIndexStatus {
  connectionId: string;
  state: QuickOpenIndexState;
  itemCount: number;
  capturedAt?: string;
  error?: string;
}

export function quickOpenIndexStatus(connectionId: string, payload: unknown, nowMs = Date.now()): QuickOpenIndexStatus {
  const cache = decodeQuickOpenMetadataCache(payload, nowMs);
  return cache && cache.connectionId === connectionId ? quickOpenIndexStatusFromCache(connectionId, cache) : { connectionId, state: "not-built", itemCount: 0 };
}

export function quickOpenIndexStatusFromCache(connectionId: string, cache: Pick<QuickOpenMetadataCache, "items" | "capturedAt" | "state" | "error">): QuickOpenIndexStatus {
  return {
    connectionId,
    state: cache.state ?? "ready",
    itemCount: cache.items.length,
    capturedAt: cache.capturedAt,
    ...(cache.error ? { error: cache.error } : {}),
  };
}
