import type { KvGetResponse, KvKeySummary } from "@/lib/backend/api";

export type KvMetadataRefreshDecision = { type: "notFound" } | { type: "stop" } | { type: "reload" } | { type: "update"; ttl: number };

export class KvListRequestGuard {
  private foregroundGeneration = 0;
  private snapshotRevision = 0;

  beginForegroundRequest(): number {
    this.snapshotRevision++;
    return ++this.foregroundGeneration;
  }

  isForegroundRequestCurrent(generation: number): boolean {
    return generation === this.foregroundGeneration;
  }

  captureSnapshotRevision(): number {
    return this.snapshotRevision;
  }

  isSnapshotRevisionCurrent(revision: number): boolean {
    return revision === this.snapshotRevision;
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

export function loadedKvPageCount(loadedKeyCount: number, pageSize: number): number {
  if (!Number.isInteger(pageSize) || pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(Math.max(0, loadedKeyCount) / pageSize));
}

export function selectedKeyMissingFromCompleteSnapshot(selectedKey: string | null, keys: readonly KvKeySummary[], continuation?: string | null): boolean {
  return !!selectedKey && !continuation && !keys.some((key) => key.key === selectedKey);
}
