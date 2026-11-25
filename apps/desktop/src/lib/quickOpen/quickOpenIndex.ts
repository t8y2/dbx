import { decodeQuickOpenMetadataCache } from "@/lib/quickOpen/quickOpenMetadataCache";

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
  // Older and passively collected snapshots are usable for search without a recorded build.
  if (!cache?.state || cache.connectionId !== connectionId) return { connectionId, state: "not-built", itemCount: 0 };
  return {
    connectionId,
    state: cache.state,
    itemCount: cache.items.length,
    capturedAt: cache.capturedAt,
    ...(cache.error ? { error: cache.error } : {}),
  };
}
