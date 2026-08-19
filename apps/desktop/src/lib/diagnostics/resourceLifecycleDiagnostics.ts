import type { QueryTab } from "@/types/database";
import { getResultCacheDiagnostics } from "@/lib/tabs/tabResultCache";
import { getMetadataRuntimeCacheDiagnostics } from "@/lib/metadata/metadataRuntimeCache";

const cancellation = {
  count: 0,
  totalLatencyMs: 0,
  maxLatencyMs: 0,
};

export function recordQueryCancellationLatency(durationMs: number) {
  cancellation.count += 1;
  cancellation.totalLatencyMs += durationMs;
  cancellation.maxLatencyMs = Math.max(cancellation.maxLatencyMs, durationMs);
}

export function resourceLifecycleDiagnostics(tabs: readonly QueryTab[]) {
  const cache = getResultCacheDiagnostics();
  const metadataCache = getMetadataRuntimeCacheDiagnostics();
  return {
    activeTasks: tabs.filter((tab) => tab.isExecuting || tab.isExplaining || tab.isCancelling).length,
    cancellationCount: cancellation.count,
    averageCancellationLatencyMs: cancellation.count ? cancellation.totalLatencyMs / cancellation.count : 0,
    maxCancellationLatencyMs: cancellation.maxLatencyMs,
    ...cache,
    metadataCache,
  };
}
