import type { KvKeySummary } from "@/lib/api";

export function refreshedKvSelectionKey(previousKey: string | null | undefined, refreshedKeys: readonly KvKeySummary[]): string | null {
  if (!previousKey) return null;
  return refreshedKeys.some((item) => item.key === previousKey) ? previousKey : null;
}
