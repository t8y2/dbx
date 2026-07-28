import type { KvKeySummary } from "@/lib/backend/api";

export function refreshedKvSelectionSummary(previousIdentity: string | null | undefined, refreshedKeys: readonly KvKeySummary[]): KvKeySummary | null {
  if (!previousIdentity) return null;
  return refreshedKeys.find((item) => (item.keyIdentity ?? item.key) === previousIdentity) ?? null;
}
