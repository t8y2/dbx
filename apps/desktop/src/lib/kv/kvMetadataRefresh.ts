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

function matchesKvKey(summary: KvKeySummary, key: string, keyIdentity?: string | null): boolean {
  return keyIdentity != null ? (summary.keyIdentity ?? summary.key) === keyIdentity : summary.key === key;
}

export function removeMissingKvKey(keys: readonly KvKeySummary[], missingKey: string, missingKeyIdentity?: string | null): KvKeySummary[] {
  return keys.filter((summary) => !matchesKvKey(summary, missingKey, missingKeyIdentity));
}

export function hasPositiveKvLease(lease: string | number | null | undefined): boolean {
  if (typeof lease === "number") return Number.isInteger(lease) && lease > 0;
  return typeof lease === "string" && /^[1-9]\d*$/.test(lease.trim());
}

export function knownKvLeaseSummaries(keys: readonly KvKeySummary[], selectedKeyIdentity: string | null): KvKeySummary[] {
  return keys.filter((key) => (key.keyIdentity ?? key.key) !== selectedKeyIdentity && hasPositiveKvLease(key.lease));
}

export function mergeKvKeyMetadata(keys: readonly KvKeySummary[], key: string, incoming: KvGetResponse, keyIdentity?: string | null): KvKeySummary[] {
  if (!incoming.found) return removeMissingKvKey(keys, key, keyIdentity);
  if (!incoming.metadata) return [...keys];
  return keys.map((item) => (matchesKvKey(item, key, keyIdentity) ? { ...item, ...incoming.metadata, key: item.key, valueSize: item.valueSize } : item));
}

export function nextKvLeaseRefreshDelay(currentDelayMs: number, failed: boolean, baseDelayMs = 2000, maxDelayMs = 30000): number {
  if (!failed) return baseDelayMs;
  return Math.min(maxDelayMs, Math.max(baseDelayMs, currentDelayMs) * 2);
}
