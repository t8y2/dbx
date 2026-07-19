import type { QueryTab } from "@/types/database";
import { getResultCacheDiagnostics } from "@/lib/tabs/tabResultCache";

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
  return {
    activeTasks: tabs.filter((tab) => tab.isExecuting || tab.isExplaining || tab.isCancelling).length,
    cancellationCount: cancellation.count,
    averageCancellationLatencyMs: cancellation.count ? cancellation.totalLatencyMs / cancellation.count : 0,
    maxCancellationLatencyMs: cancellation.maxLatencyMs,
    ...cache,
  };
}
