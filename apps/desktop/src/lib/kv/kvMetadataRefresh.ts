import type { KvGetResponse, KvKeySummary } from "@/lib/backend/api";

export type KvMetadataRefreshDecision = { type: "notFound" } | { type: "stop" } | { type: "reload" } | { type: "update"; ttl: number };

export class KvListRequestGuard {
  private foregroundGeneration = 0;

  beginForegroundRequest(): number {
    return ++this.foregroundGeneration;
  }

  isForegroundRequestCurrent(generation: number): boolean {
    return generation === this.foregroundGeneration;
  }
}

export function decideKvMetadataRefresh(current: KvGetResponse | null, incoming: KvGetResponse): KvMetadataRefreshDecision {
  if (!incoming.found) return { type: "notFound" };
  if (!current?.found || !incoming.metadata) return { type: "stop" };
  if (!current.metadata) return { type: "reload" };

  const revisionChanged = current.metadata.modRevision != null && incoming.metadata.modRevision != null && current.metadata.modRevision !== incoming.metadata.modRevision;
  const leaseChanged = current.metadata.lease != null && incoming.metadata.lease != null && current.metadata.lease !== incoming.metadata.lease;
  const ttl = incoming.metadata.ttl;

  if (revisionChanged || leaseChanged || ttl == null) return { type: "reload" };
  return { type: "update", ttl: Math.max(0, ttl) };
}

export function updateKvResponseTtl(current: KvGetResponse, ttl: number): boolean {
  if (!current.metadata) return false;
  current.metadata.ttl = ttl;
  return true;
}

export function mergeKvValueRefresh(current: KvGetResponse | null, incoming: KvGetResponse): KvGetResponse {
  if (!current?.found || !incoming.found || !current.metadata || !incoming.metadata) return incoming;

  const sameValue = current.value?.encoding === incoming.value?.encoding && current.value?.data === incoming.value?.data;
  const sameRevision = current.metadata.modRevision === incoming.metadata.modRevision;
  const sameLease = current.metadata.lease === incoming.metadata.lease;
  if (!sameValue || !sameRevision || !sameLease) return incoming;

  if (incoming.metadata.ttl != null) current.metadata.ttl = Math.max(0, incoming.metadata.ttl);
  return current;
}

export function removeMissingKvKey(keys: readonly KvKeySummary[], missingKey: string): KvKeySummary[] {
  return keys.filter((key) => key.key !== missingKey);
}

export function knownKvLeaseKeys(keys: readonly KvKeySummary[], selectedKey: string | null): string[] {
  return keys.filter((key) => key.key !== selectedKey && typeof key.lease === "number" && key.lease > 0).map((key) => key.key);
}

export function mergeKvKeyMetadata(keys: readonly KvKeySummary[], key: string, incoming: KvGetResponse): KvKeySummary[] {
  if (!incoming.found) return removeMissingKvKey(keys, key);
  if (!incoming.metadata) return [...keys];
  return keys.map((item) => (item.key === key ? { ...item, ...incoming.metadata, key: item.key, valueSize: item.valueSize } : item));
}

export function nextKvLeaseRefreshDelay(currentDelayMs: number, failed: boolean, baseDelayMs = 2000, maxDelayMs = 30000): number {
  if (!failed) return baseDelayMs;
  return Math.min(maxDelayMs, Math.max(baseDelayMs, currentDelayMs) * 2);
}
