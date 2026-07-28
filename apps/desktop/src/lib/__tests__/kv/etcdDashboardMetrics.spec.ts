import { describe, expect, it } from "vitest";
import type { KvPrometheusMetrics } from "@/lib/backend/tauri";
import { counterMapRates, counterRate, histogramAverageMilliseconds, histogramMapAverageMilliseconds, ratePercentage } from "@/lib/kv/etcdDashboardMetrics";

function snapshot(values: Partial<KvPrometheusMetrics>): KvPrometheusMetrics {
  return {
    available: true,
    sourceUrl: "http://localhost:2380/metrics",
    grpcMethodRequestsTotal: {},
    grpcMethodFailuresTotal: {},
    requestDurationSecondsSumByType: {},
    requestDurationSecondsCountByType: {},
    ...values,
  };
}

describe("etcd dashboard metrics", () => {
  it("converts cumulative counters to rates using adjacent snapshots", () => {
    const previous = snapshot({ collectedAtMs: 10_000, grpcRequestsTotal: 100 });
    const current = snapshot({ collectedAtMs: 20_000, grpcRequestsTotal: 160 });

    expect(counterRate(current, previous, "grpcRequestsTotal")).toBe(6);
  });

  it("does not report a misleading rate after a counter reset", () => {
    const previous = snapshot({ collectedAtMs: 10_000, grpcRequestsTotal: 100 });
    const current = snapshot({ collectedAtMs: 20_000, grpcRequestsTotal: 5 });

    expect(counterRate(current, previous, "grpcRequestsTotal")).toBeNull();
  });

  it("uses delta histogram observations after the first snapshot", () => {
    const previous = snapshot({
      collectedAtMs: 10_000,
      walFsyncDurationSecondsSum: 1,
      walFsyncDurationSecondsCount: 20,
    });
    const current = snapshot({
      collectedAtMs: 20_000,
      walFsyncDurationSecondsSum: 1.2,
      walFsyncDurationSecondsCount: 30,
    });

    expect(histogramAverageMilliseconds(current, previous, "walFsyncDurationSecondsSum", "walFsyncDurationSecondsCount")).toBeCloseTo(20);
  });

  it("computes a bounded failure percentage", () => {
    expect(ratePercentage(2, 20)).toBe(10);
    expect(ratePercentage(2, 0)).toBeNull();
    expect(ratePercentage(25, 20)).toBe(100);
  });

  it("calculates rates for labeled counters", () => {
    const previous = snapshot({ collectedAtMs: 10_000, grpcMethodRequestsTotal: { Range: 100, Put: 4 } });
    const current = snapshot({ collectedAtMs: 20_000, grpcMethodRequestsTotal: { Range: 160, Put: 14 } });

    expect(counterMapRates(current, previous, "grpcMethodRequestsTotal")).toEqual({ Range: 6, Put: 1 });
  });

  it("calculates per-operation latency from labeled histogram deltas", () => {
    const previous = snapshot({
      collectedAtMs: 10_000,
      requestDurationSecondsSumByType: { Range: 1 },
      requestDurationSecondsCountByType: { Range: 20 },
    });
    const current = snapshot({
      collectedAtMs: 20_000,
      requestDurationSecondsSumByType: { Range: 1.2 },
      requestDurationSecondsCountByType: { Range: 30 },
    });

    expect(histogramMapAverageMilliseconds(current, previous, "requestDurationSecondsSumByType", "requestDurationSecondsCountByType").Range).toBeCloseTo(20);
  });
});
